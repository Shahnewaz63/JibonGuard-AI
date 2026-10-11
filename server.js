import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of (existsSync(path.join(__dirname, '.env')) ? readFileSync(path.join(__dirname, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !match[1].startsWith('#') && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}

const app = express();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = (process.env.APP_ENV || 'development').toLowerCase() === 'production';
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE = 'jg_session';
const CSRF_COOKIE = 'jg_csrf';
const SESSION_LIFETIME = 12 * 60 * 60;
const REMEMBER_LIFETIME = 30 * 24 * 60 * 60;
const TOKEN_LIFETIME = 60 * 60;
const PASSWORD_MIN = 12;
const DB_PATH = process.env.JIBONGUARD_DB || path.join(__dirname, 'jibonguard.sqlite3');
if (IS_PRODUCTION && SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
if (IS_PRODUCTION && (!PUBLIC_ORIGIN.startsWith('https://') || !new URL(PUBLIC_ORIGIN).host || new URL(PUBLIC_ORIGIN).pathname !== '/')) throw new Error('Set PUBLIC_ORIGIN to the exact production HTTPS origin.');
if (IS_PRODUCTION && (!process.env.SMTP_HOST || !(process.env.SMTP_FROM || process.env.SMTP_USER))) throw new Error('Set SMTP_HOST and SMTP_FROM (or SMTP_USER) in production.');
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const OPEN_METEO_API_KEY = (process.env.OPEN_METEO_API_KEY || '').trim();
const BREAK_ALERTS = { break: 'Water and shade break', rain: 'Rain safety alert', storm: 'Storm safety alert', earthquake: 'Earthquake safety alert' };
const BANGLA_DIGITS = '\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef';
const toAsciiDigits = value => String(value || '').replace(/[\u09e6-\u09ef]/g, digit => String(BANGLA_DIGITS.indexOf(digit)));
const scrypt = promisify(scryptCb);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');

db.exec(`
CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,organization_type TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',estimated_workers INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,full_name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,phone TEXT NOT NULL,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('organization_owner')),email_verified_at INTEGER,privacy_notice_version TEXT NOT NULL,privacy_consent_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS action_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id); CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at); CREATE INDEX IF NOT EXISTS action_tokens_user_idx ON action_tokens(user_id);
CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,name TEXT NOT NULL,phone TEXT NOT NULL,site TEXT NOT NULL,job_type TEXT NOT NULL,workload TEXT NOT NULL DEFAULT 'Standard',risk_level TEXT NOT NULL DEFAULT 'Moderate',outdoor_minutes INTEGER NOT NULL DEFAULT 0,last_break TEXT NOT NULL DEFAULT '',consent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,name TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',latitude REAL,longitude REAL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(organization_id,name));
CREATE TABLE IF NOT EXISTS worker_consent_events(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,action TEXT NOT NULL CHECK(action IN ('consented','withdrawn')),method TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS consent_worker_idx ON worker_consent_events(organization_id,worker_id,changed_at DESC); CREATE INDEX IF NOT EXISTS workers_org_idx ON workers(organization_id,created_at);
CREATE TABLE IF NOT EXISTS break_logs(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,title TEXT NOT NULL,site TEXT NOT NULL,break_date TEXT NOT NULL,break_time TEXT NOT NULL,duration_minutes INTEGER NOT NULL,worker_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'logged' CHECK(status IN ('logged','scheduled')),source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),alert_type TEXT NOT NULL DEFAULT 'break',ai_rationale TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS break_logs_org_idx ON break_logs(organization_id,break_date DESC,break_time DESC);
`);
for (const [table, column, declaration] of [
  ['workers', 'site_id', 'TEXT'], ['workers', 'consent_method', "TEXT NOT NULL DEFAULT ''"],
  ['break_logs', 'source', "TEXT NOT NULL DEFAULT 'manual'"], ['break_logs', 'alert_type', "TEXT NOT NULL DEFAULT 'break'"], ['break_logs', 'ai_rationale', "TEXT NOT NULL DEFAULT ''"],
]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
for (const row of db.prepare("SELECT DISTINCT organization_id,site FROM workers WHERE trim(site)<>'' AND site_id IS NULL").all()) {
  let site = db.prepare('SELECT id FROM sites WHERE organization_id=? AND name=? COLLATE NOCASE').get(row.organization_id, row.site);
  if (!site) {
    const id = token(12), stamp = now();
    db.prepare("INSERT INTO sites(id,organization_id,name,address,latitude,longitude,created_at,updated_at) VALUES(?,?,?,'',NULL,NULL,?,?)").run(id, row.organization_id, row.site, stamp, stamp);
    site = { id };
  }
  db.prepare('UPDATE workers SET site_id=? WHERE organization_id=? AND site=? AND site_id IS NULL').run(site.id, row.organization_id, row.site);
}

const WEATHER_CACHE = new Map();
const GEO_CACHE = new Map();
const RATE_LIMITS = new Map();
const now = () => Math.floor(Date.now() / 1000);
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
const hashToken = value => SESSION_SECRET ? createHmac('sha256', SESSION_SECRET).update(value).digest('hex') : createHash('sha256').update(value).digest('hex');
const rateAllowed = (req, key, limit = 5, windowSeconds = 900) => {
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const id = `${key}:${address}`, cutoff = Date.now() - windowSeconds * 1000;
  const entries = (RATE_LIMITS.get(id) || []).filter(stamp => stamp >= cutoff);
  if (entries.length >= limit) { RATE_LIMITS.set(id, entries); return false; }
  entries.push(Date.now()); RATE_LIMITS.set(id, entries); return true;
};
const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(pair => pair.length === 2).map(([key, value]) => [key, decodeURIComponent(value)]));
const cookieOptions = (httpOnly, maxAge) => ({ httpOnly, sameSite: 'lax', secure: IS_PRODUCTION, path: '/', maxAge: maxAge * 1000 });
const appOrigin = req => {
  if (!IS_PRODUCTION) {
    try { const origin = new URL(req.get('origin')); if (['127.0.0.1','localhost','::1'].includes(origin.hostname)) return origin.origin; } catch { /* use configured origin */ }
  }
  return PUBLIC_ORIGIN;
};
const sendError = (res, status, error) => res.status(status).json({ error });
const sessionUser = req => {
  const opaque = parseCookies(req)[SESSION_COOKIE];
  if (!opaque) return null;
  const stamp = now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(stamp);
  db.prepare('DELETE FROM action_tokens WHERE expires_at < ?').run(stamp);
  return db.prepare(`SELECT u.id,u.organization_id,u.full_name,u.email,u.phone,u.role,o.name AS organization_name,o.organization_type
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.organization_id
    WHERE s.token_hash=? AND s.expires_at>=?`).get(hashToken(opaque), stamp) || null;
};
const csrfToken = req => {
  const existing = parseCookies(req)[CSRF_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing)) return { value: existing, set: false };
  return { value: token(32), set: true };
};
const csrfAndOrigin = (req, res, next) => {
  const origin = req.get('origin');
  const host = req.get('host') || '';
  let validOrigin = origin === PUBLIC_ORIGIN;
  if (!validOrigin && !IS_PRODUCTION && origin) {
    try { const parsed = new URL(origin); validOrigin = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && /^https?:$/.test(parsed.protocol); } catch { validOrigin = false; }
  }
  const cookies = parseCookies(req), header = req.get('x-csrf-token') || '';
  if (!validOrigin) return sendError(res, 403, 'Request origin could not be verified. Reload the page and try again.');
  if (!cookies[CSRF_COOKIE] || !header || cookies[CSRF_COOKIE] !== header) return sendError(res, 403, 'Your security token expired. Reload the page and try again.');
  next();
};
const requireUser = (req, res, next) => {
  req.user = sessionUser(req);
  if (!req.user) return sendError(res, 401, 'Sign in to continue.');
  next();
};
const hashPassword = async password => {
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { passwordHash: digest.toString('hex'), passwordSalt: salt.toString('hex') };
};
const checkPassword = async (password, savedHash, saltHex) => {
  const digest = await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(savedHash, 'hex');
  return digest.length === expected.length && timingSafeEqual(digest, expected);
};
const issueActionToken = (userId, purpose) => {
  const value = token(32), stamp = now();
  db.prepare('DELETE FROM action_tokens WHERE user_id=? AND purpose=?').run(userId, purpose);
  db.prepare('INSERT INTO action_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES(?,?,?,?,?)').run(hashToken(value), userId, purpose, stamp + TOKEN_LIFETIME, stamp);
  return value;
};

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; frame-src https://www.openstreetmap.org; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" });
  if (IS_PRODUCTION) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { if (!req.path.startsWith('/api/')) console.log(`${req.method} ${req.path}`); next(); });

app.get('/api/auth/csrf', (req, res) => {
  const csrf = csrfToken(req);
  if (csrf.set) res.cookie(CSRF_COOKIE, csrf.value, cookieOptions(false, REMEMBER_LIFETIME));
  res.set('Cache-Control', 'no-store').json({ csrf_token: csrf.value });
});
app.get('/api/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, service: 'jibonguard-api' }));
app.get('/api/auth/me', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json({ authenticated: true, user: req.user }));
app.get('/api/workers', requireUser, (req, res) => {
  const workers = db.prepare(`SELECT w.*,COALESCE((SELECT action FROM worker_consent_events e WHERE e.worker_id=w.id ORDER BY e.changed_at DESC,e.rowid DESC LIMIT 1),'pending') AS consent_status FROM workers w WHERE organization_id=? ORDER BY name COLLATE NOCASE`).all(req.user.organization_id);
  res.json({ workers });
});
app.get('/api/sites', requireUser, (req, res) => res.json({ sites: db.prepare('SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE').all(req.user.organization_id) }));
app.get('/api/breaks', requireUser, (req, res) => {
  const date = String(req.query.date || '');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(res, 400, 'Enter a valid date.');
  const records = db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE organization_id=? ORDER BY break_date DESC,break_time DESC,created_at DESC').all(req.user.organization_id);
  res.json({ breaks: records, total: records.length, date_total: date ? records.filter(row => row.break_date === date && row.status === 'logged').length : 0 });
});
app.get('/api/privacy/export', requireUser, (req, res) => {
  const organization = db.prepare('SELECT name,organization_type,phone,address,estimated_workers,created_at FROM organizations WHERE id=?').get(req.user.organization_id);
  const privacy = db.prepare('SELECT privacy_notice_version,privacy_consent_at,created_at FROM users WHERE id=?').get(req.user.id);
  const workers = db.prepare('SELECT id,name,phone,site,site_id,job_type,workload,risk_level,outdoor_minutes,last_break,consent_at,consent_method,created_at,updated_at FROM workers WHERE organization_id=? ORDER BY name COLLATE NOCASE').all(req.user.organization_id);
  const sites = db.prepare('SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE').all(req.user.organization_id);
  const break_logs = db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE organization_id=? ORDER BY break_date DESC,break_time DESC').all(req.user.organization_id);
  const worker_consent_events = db.prepare('SELECT worker_id,action,method,note,changed_by,changed_at FROM worker_consent_events WHERE organization_id=? ORDER BY changed_at DESC,rowid DESC').all(req.user.organization_id);
  res.set('Content-Disposition', 'attachment; filename=jibonguard-account-data.json').json({ account: req.user, organization, workers, sites, worker_consent_events, break_logs, privacy, exported_at: new Date().toISOString() });
});

app.post('/api/auth/signup', csrfAndOrigin, async (req, res) => {
  if (!rateAllowed(req, 'signup', 4)) return sendError(res, 429, 'Too many sign-up attempts. Please try again later.');
  const d = req.body, name = String(d.name || '').trim(), organization = String(d.organization || '').trim(), type = String(d.organization_type || '').trim();
  const phone = String(d.phone || '').trim(), email = String(d.email || '').trim().toLowerCase(), password = d.password;
  const workerCount = String(d.estimated_workers ?? '0').trim();
  if (!name || !organization || !phone || !email || name.length > 120 || organization.length > 160) return sendError(res, 400, 'Complete the required fields. Names must be within the stated length.');
  if (!/^[^\s@]{1,64}@[^ @.]+(?:\.[^ @.]+)+$/.test(email) || email.length > 254) return sendError(res, 400, 'Enter a valid email address.');
  if (!/^[+()0-9 .-]{7,24}$/.test(phone)) return sendError(res, 400, 'Enter a valid phone number.');
  if (!['construction','factory','ngo','union','garage','farm','government','other'].includes(type)) return sendError(res, 400, 'Choose an organization type.');
  if (!/^\d+$/.test(workerCount) || Number(workerCount) > 1_000_000) return sendError(res, 400, 'Enter an estimated worker count from 0 to 1,000,000.');
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 128) return sendError(res, 400, `Use a password between ${PASSWORD_MIN} and 128 characters.`);
  if (d.privacy_consent !== true) return sendError(res, 400, 'Please review and accept the privacy notice and terms.');
  const ids = token(18), organizationId = token(18), stamp = now(), { passwordHash, passwordSalt } = await hashPassword(password);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO organizations(id,name,organization_type,phone,estimated_workers,created_at) VALUES(?,?,?,?,?,?)').run(organizationId, organization, type, phone, Number(workerCount), stamp);
    db.prepare(`INSERT INTO users(id,organization_id,full_name,email,phone,password_hash,password_salt,role,privacy_notice_version,privacy_consent_at,email_verified_at,created_at)
      VALUES(?,?,?,?,?,?,?,'organization_owner','2026-10-01',?,?,?)`).run(ids, organizationId, name, email, phone, passwordHash, passwordSalt, stamp, stamp, stamp);
    db.exec('COMMIT');
    res.status(201).json({ message: 'Account created. You can sign in now.' });
  } catch (error) { db.exec('ROLLBACK'); if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'An account with these details already exists.'); throw error; }
});

app.post('/api/auth/login', csrfAndOrigin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), password = req.body.password;
  if (email.length > 254 || typeof password !== 'string' || password.length > 128) return sendError(res, 400, 'Enter a valid email and password.');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) { await hashPassword(password || 'invalid-password'); return sendError(res, 401, 'Email or password is incorrect.'); }
  if (!(await checkPassword(password, user.password_hash, user.password_salt))) return sendError(res, 401, 'Email or password is incorrect.');
  const remember = req.body.remember === true, lifetime = remember ? REMEMBER_LIFETIME : SESSION_LIFETIME, opaque = token(32), cookie = parseCookies(req)[SESSION_COOKIE];
  if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookie));
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(hashToken(opaque), user.id, now(), now() + lifetime);
  const csrf = token(32);
  res.cookie(SESSION_COOKIE, opaque, cookieOptions(true, lifetime)); res.cookie(CSRF_COOKIE, csrf, cookieOptions(false, REMEMBER_LIFETIME));
  res.json({ message: 'Signed in.', csrf_token: csrf, next: safeNext(req.body.next) });
});
app.post('/api/auth/logout', csrfAndOrigin, (req, res) => {
  const opaque = parseCookies(req)[SESSION_COOKIE];
  if (opaque) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(opaque));
  res.clearCookie(SESSION_COOKIE, cookieOptions(true, 0)); res.clearCookie(CSRF_COOKIE, cookieOptions(false, 0));
  res.json({ message: 'Signed out.' });
});
app.post('/api/auth/verify', csrfAndOrigin, (req, res) => {
  if (!rateAllowed(req, 'verify', 10)) return sendError(res, 429, 'Too many attempts. Please try again later.');
  const value = String(req.body.token || '');
  if (value.length < 30 || value.length > 100) return sendError(res, 400, 'This verification link is invalid or expired.');
  const row = db.prepare("SELECT user_id FROM action_tokens WHERE token_hash=? AND purpose='verify_email' AND expires_at>=?").get(hashToken(value), now());
  if (!row) return sendError(res, 400, 'This verification link is invalid or expired. Request a new one by signing up again.');
  db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(now(), row.user_id); db.prepare("DELETE FROM action_tokens WHERE user_id=? AND purpose='verify_email'").run(row.user_id);
  res.json({ message: 'Email verified. You can now sign in.' });
});
app.post('/api/auth/forgot', csrfAndOrigin, async (req, res) => {
  if (!rateAllowed(req, 'forgot', 5)) return sendError(res, 429, 'Too many requests. Please try again later.');
  const email = String(req.body.email || '').trim().toLowerCase(), result = { message: 'If an account matches that email, a password reset link will be sent.' };
  if (email.length <= 254 && /^[^\s@]{1,64}@[^ @.]+(?:\.[^ @.]+)+$/.test(email)) {
    const user = db.prepare('SELECT id,full_name FROM users WHERE email=?').get(email);
    if (user) {
      const secret = issueActionToken(user.id, 'reset_password'), link = `${appOrigin(req)}/login.html?mode=reset&token=${encodeURIComponent(secret)}`;
      await sendEmail(email, 'Reset your JibonGuard password', `Hello ${user.full_name},\n\nUse this one-time link to reset your password:\n${link}\n\nIt expires in one hour. If you did not request this, ignore this email.`);
      if (!IS_PRODUCTION) result.development_action_url = link;
    }
  }
  res.json(result);
});
app.post('/api/auth/resend-verification', csrfAndOrigin, async (req, res) => {
  if (!rateAllowed(req, 'resend-verification', 5)) return sendError(res, 429, 'Too many requests. Please try again later.');
  const email = String(req.body.email || '').trim().toLowerCase(), result = { message: 'If that address has an account awaiting verification, a new one-time link will be sent.' };
  if (email.length <= 254 && /^[^\s@]{1,64}@[^ @.]+(?:\.[^ @.]+)+$/.test(email)) {
    const user = db.prepare('SELECT id,full_name FROM users WHERE email=? AND email_verified_at IS NULL').get(email);
    if (user) {
      const secret = issueActionToken(user.id, 'verify_email'), link = `${appOrigin(req)}/verify.html?token=${encodeURIComponent(secret)}`;
      await sendEmail(email, 'Verify your JibonGuard email', `Hello ${user.full_name},\n\nUse this new one-time link to verify your email address:\n${link}\n\nIt expires in one hour.`);
      if (!IS_PRODUCTION) result.development_action_url = link;
    }
  }
  res.json(result);
});
app.post('/api/auth/reset', csrfAndOrigin, async (req, res) => {
  if (!rateAllowed(req, 'reset', 5)) return sendError(res, 429, 'Too many requests. Please try again later.');
  const value = String(req.body.token || ''), password = req.body.password;
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 128) return sendError(res, 400, `Use a password between ${PASSWORD_MIN} and 128 characters.`);
  if (value.length < 30 || value.length > 100) return sendError(res, 400, 'This reset link is invalid or expired.');
  const row = db.prepare("SELECT user_id FROM action_tokens WHERE token_hash=? AND purpose='reset_password' AND expires_at>=?").get(hashToken(value), now());
  if (!row) return sendError(res, 400, 'This reset link is invalid or expired. Request a new one.');
  const { passwordHash, passwordSalt } = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(passwordHash, passwordSalt, row.user_id);
  db.prepare('DELETE FROM action_tokens WHERE user_id=?').run(row.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
  res.json({ message: 'Password updated. Sign in using your new password.' });
});
app.post('/api/privacy/delete-account', csrfAndOrigin, requireUser, async (req, res) => {
  if (!rateAllowed(req, 'delete', 3)) return sendError(res, 429, 'Too many requests. Please try again later.');
  const password = req.body.password;
  if (typeof password !== 'string' || password.length > 128) return sendError(res, 400, 'Confirm your password to continue.');
  const row = db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').get(req.user.id);
  if (!row || !(await checkPassword(password, row.password_hash, row.password_salt))) return sendError(res, 401, 'Password confirmation did not match.');
  db.prepare('DELETE FROM organizations WHERE id=?').run(req.user.organization_id); res.clearCookie(SESSION_COOKIE, cookieOptions(true, 0)); res.json({ message: 'The account and organization profile were deleted.' });
});

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value) ? value : '/dashboard.html';
}
async function sendEmail(recipient, subject, body) {
  const host = process.env.SMTP_HOST;
  if (!host) {
    if (IS_PRODUCTION) throw new Error('Email delivery is not configured.');
    console.log(`\n[development email] To: ${recipient}\nSubject: ${subject}\n${body}\n`);
    return;
  }
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, ...(process.env.SMTP_USER && process.env.SMTP_PASSWORD ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}) });
  await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: recipient, subject, text: body });
}
function normalizePhone(value) {
  const bangla = '০১২৩৪৫৬৭৮৯', normalized = String(value || '').replace(/[০-৯]/g, digit => String(bangla.indexOf(digit))).trim();
  const digits = normalized.replace(/\D/g, '');
  if (normalized.startsWith('+')) return /^\d{10,15}$/.test(digits) ? `+${digits}` : null;
  if (digits.startsWith('00')) return /^\d{10,15}$/.test(digits.slice(2)) ? `+${digits.slice(2)}` : null;
  if (digits.startsWith('0')) return `+880${digits.slice(1)}`;
  if (digits.startsWith('880')) return `+${digits}`;
  return null;
}
function workerValues(data, organizationId) {
  const banglaDigits = '০১২৩৪৫৬৭৮৯', name = String(data.name || '').trim(), phone = String(data.phone || '').replace(/[০-৯]/g, digit => String(banglaDigits.indexOf(digit))).trim();
  const siteId = String(data.site_id || '').trim(), legacySite = String(data.site || '').trim();
  const jobType = String(data.job_type || '').trim(), workload = String(data.workload || 'Standard').trim();
  if (!name || name.length > 120 || !/^[+()0-9 .-]{7,24}$/.test(phone) || !jobType || jobType.length > 120 || !['Light','Standard','Heavy'].includes(workload)) return null;
  const site = db.prepare('SELECT id,name FROM sites WHERE organization_id=? AND (id=? OR name=? COLLATE NOCASE)').get(organizationId, siteId, legacySite);
  if (!site) throw Object.assign(new Error('Choose a worksite from your saved Sites list. Create the site first if it is not listed.'), { status: 400 });
  return { name, phone, siteId: site.id, site: site.name, jobType, workload };
}
function siteValues(data) {
  const name = String(data.name || '').trim(), address = String(data.address || '').trim(), latitudeRaw = String(data.latitude ?? '').trim(), longitudeRaw = String(data.longitude ?? '').trim(), latitude = Number(latitudeRaw), longitude = Number(longitudeRaw);
  if (!name || name.length > 120 || address.length > 240 || !latitudeRaw || !longitudeRaw || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { name, address, latitude, longitude };
}
function addWorker(data, org, stamp = now()) {
  const values = workerValues(data, org);
  if (!values) throw Object.assign(new Error('Enter a name, valid phone, site, job type, and workload.'), { status: 400 });
  const id = token(12);
  db.prepare('INSERT INTO workers(id,organization_id,name,phone,site_id,site,job_type,workload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, org, values.name, values.phone, values.siteId, values.site, values.jobType, values.workload, stamp, stamp);
  return db.prepare('SELECT * FROM workers WHERE id=?').get(id);
}
app.post('/api/workers', csrfAndOrigin, requireUser, (req, res) => {
  try { res.status(201).json({ worker: addWorker(req.body, req.user.organization_id) }); }
  catch (error) { sendError(res, error.status || (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400), error.message || 'Could not save worker.'); }
});
app.post('/api/workers/import', csrfAndOrigin, requireUser, (req, res) => {
  const rows = req.body.workers;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) return sendError(res, 400, 'Choose a CSV with between 1 and 500 worker rows.');
  try {
    const normalized = rows.map(row => workerValues(row, req.user.organization_id));
    if (normalized.some(row => !row)) return sendError(res, 400, 'The CSV contains invalid worker data. Check name, phone, site, job type, and workload; no rows were imported.');
    const stamp = now(); db.exec('BEGIN IMMEDIATE');
    try { for (const row of normalized) db.prepare('INSERT INTO workers(id,organization_id,name,phone,site_id,site,job_type,workload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(token(12), req.user.organization_id, row.name, row.phone, row.siteId, row.site, row.jobType, row.workload, stamp, stamp); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    res.status(201).json({ imported: normalized.length });
  } catch (error) { sendError(res, error.status || 400, `${error.message || 'Invalid worker data.'} No rows were imported.`); }
});
app.put('/api/workers', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return sendError(res, 404, 'Not found.');
  try {
    const values = workerValues(req.body, req.user.organization_id);
    if (!values) return sendError(res, 400, 'Enter a name, valid phone, site, job type, and workload.');
    const result = db.prepare('UPDATE workers SET name=?,phone=?,site_id=?,site=?,job_type=?,workload=?,updated_at=? WHERE id=? AND organization_id=?').run(values.name, values.phone, values.siteId, values.site, values.jobType, values.workload, now(), id, req.user.organization_id);
    if (!result.changes) return sendError(res, 404, 'Worker not found.');
    res.json({ worker: db.prepare('SELECT * FROM workers WHERE id=?').get(id) });
  } catch (error) { sendError(res, error.status || 400, error.message); }
});
app.delete('/api/workers', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || ''), result = db.prepare('DELETE FROM workers WHERE id=? AND organization_id=?').run(id, req.user.organization_id);
  if (!result.changes) return sendError(res, 404, 'Worker not found.');
  res.json({ message: 'Worker removed.' });
});
app.post('/api/workers/consent', csrfAndOrigin, requireUser, (req, res) => {
  const workerId = String(req.body.worker_id || '').trim(), action = String(req.body.action || '').trim();
  let method = String(req.body.method || '').trim(); const note = String(req.body.note || '').trim();
  if (!['consented','withdrawn'].includes(action) || note.length > 500) return sendError(res, 400, 'Choose a valid consent action and keep notes under 500 characters.');
  if (action === 'consented' && (!['written','verbal'].includes(method) || req.body.worker_agreed !== true)) return sendError(res, 400, 'Record consent only after the worker has received the notice and explicitly agreed.');
  if (action === 'withdrawn') method = '';
  const stamp = now(), org = req.user.organization_id, worker = db.prepare('SELECT id FROM workers WHERE id=? AND organization_id=?').get(workerId, org);
  if (!worker) return sendError(res, 404, 'Worker not found.');
  db.prepare('UPDATE workers SET consent_at=?,consent_method=?,updated_at=? WHERE id=? AND organization_id=?').run(action === 'consented' ? stamp : null, method, stamp, workerId, org);
  db.prepare('INSERT INTO worker_consent_events(id,organization_id,worker_id,action,method,note,changed_by,changed_at) VALUES(?,?,?,?,?,?,?,?)').run(token(12), org, workerId, action, method, note, req.user.id, stamp);
  res.json({ worker: { ...db.prepare('SELECT id,name,consent_at,consent_method,updated_at FROM workers WHERE id=?').get(workerId), consent_status: action }, message: 'Consent status updated and logged.' });
});

app.post('/api/sites', csrfAndOrigin, requireUser, (req, res) => {
  const values = siteValues(req.body);
  if (!values) return sendError(res, 400, 'Enter a site name, address (optional), and valid latitude/longitude for weather.');
  const id = token(12), stamp = now();
  try {
    db.prepare('INSERT INTO sites(id,organization_id,name,address,latitude,longitude,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, req.user.organization_id, values.name, values.address, values.latitude, values.longitude, stamp, stamp);
    res.status(201).json({ site: db.prepare('SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE id=?').get(id) });
  } catch (error) { sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400, 'A site with this name already exists in your organization.'); }
});
app.put('/api/sites', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || ''), values = siteValues(req.body);
  if (!values) return sendError(res, 400, 'Enter a site name, address (optional), and valid latitude/longitude for weather.');
  try {
    const result = db.prepare('UPDATE sites SET name=?,address=?,latitude=?,longitude=?,updated_at=? WHERE id=? AND organization_id=?').run(values.name, values.address, values.latitude, values.longitude, now(), id, req.user.organization_id);
    if (!result.changes) return sendError(res, 404, 'Site not found.');
    db.prepare('UPDATE workers SET site=? WHERE site_id=? AND organization_id=?').run(values.name, id, req.user.organization_id);
    WEATHER_CACHE.delete(id);
    res.json({ site: db.prepare('SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE id=?').get(id) });
  } catch (error) { sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400, 'A site with this name already exists in your organization.'); }
});
app.delete('/api/sites', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || '');
  if (db.prepare('SELECT 1 FROM workers WHERE organization_id=? AND site_id=? LIMIT 1').get(req.user.organization_id, id)) return sendError(res, 409, 'Move or remove workers assigned to this site before deleting it.');
  const result = db.prepare('DELETE FROM sites WHERE id=? AND organization_id=?').run(id, req.user.organization_id);
  if (!result.changes) return sendError(res, 404, 'Site not found.');
  WEATHER_CACHE.delete(id); res.json({ message: 'Site removed.' });
});

function weatherSummary(code) {
  const summaries = { 0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Depositing rime fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',56:'Light freezing drizzle',57:'Freezing drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',66:'Light freezing rain',67:'Freezing rain',71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',80:'Light rain showers',81:'Rain showers',82:'Heavy rain showers',85:'Light snow showers',86:'Snow showers',95:'Thunderstorm',96:'Thunderstorm with light hail',99:'Thunderstorm with heavy hail' };
  return summaries[Number(code)] || 'Conditions unavailable';
}
async function openMeteo(site, forecastDays = 1) {
  const params = new URLSearchParams({ latitude: site.latitude, longitude: site.longitude,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m',
    forecast_days: String(forecastDays), timezone: 'auto', temperature_unit: 'celsius', wind_speed_unit: 'ms', precipitation_unit: 'mm' });
  const host = OPEN_METEO_API_KEY ? 'customer-api.open-meteo.com' : 'api.open-meteo.com';
  if (OPEN_METEO_API_KEY) params.set('apikey', OPEN_METEO_API_KEY);
  const response = await fetch(`https://${host}/v1/forecast?${params}`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'User-Agent': 'JibonGuard/1.0' } });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok || !raw.current) throw new Error(response.status === 429 ? 'Open-Meteo request limit reached. Weather will be available again shortly.' : response.status === 401 || response.status === 403 ? 'Open-Meteo rejected the customer API key. Check OPEN_METEO_API_KEY in .env.' : raw.reason || `Open-Meteo could not return weather right now (HTTP ${response.status}).`);
  return raw;
}
function shapeWeather(raw) {
  const c = raw.current || {}, hourly = raw.hourly || {}, data = [];
  const fields = { temperature:'temperature_2m', humidity:'relative_humidity_2m', feels_like:'apparent_temperature', precipitation_probability:'precipitation_probability', precipitation:'precipitation', weather_code:'weather_code', wind_speed:'wind_speed_10m' };
  for (let index = 0; index < (hourly.time || []).length; index++) {
    const stamp = hourly.time[index];
    if (!/^\d{4}-\d\d-\d\dT\d\d:00$/.test(stamp)) continue;
    const hour = Number(stamp.slice(11, 13));
    if (hour % 2) continue;
    const row = { time: stamp, label: `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}` };
    for (const [key, field] of Object.entries(fields)) row[key === 'weather_code' ? 'summary' : key] = key === 'weather_code' ? weatherSummary((hourly[field] || [])[index]) : (hourly[field] || [])[index] ?? null;
    data.push(row);
  }
  return { current: { temperature:c.temperature_2m,summary:weatherSummary(c.weather_code),feels_like:c.apparent_temperature,humidity:c.relative_humidity_2m,precipitation:c.precipitation,wind:{speed:c.wind_speed_10m,gusts:c.wind_gusts_10m,direction:c.wind_direction_10m} }, hourly:{ data } };
}
app.get('/api/sites/:siteId/weather', requireUser, async (req, res) => {
  const site = db.prepare('SELECT id,name,address,latitude,longitude FROM sites WHERE id=? AND organization_id=?').get(req.params.siteId, req.user.organization_id);
  if (!site) return sendError(res, 404, 'Site not found.');
  if (site.latitude == null || site.longitude == null) return sendError(res, 422, "Add this site's latitude and longitude in Site settings to load weather.");
  const cacheKey = `${site.id}:${site.latitude}:${site.longitude}`, cached = WEATHER_CACHE.get(cacheKey);
  if (cached && cached.expires > Date.now()) return res.json({ site_id: site.id, weather: cached.value, cached: true });
  try { const result = shapeWeather(await openMeteo(site)); WEATHER_CACHE.set(cacheKey, { expires:Date.now()+600000,value:result }); res.json({ site_id:site.id,weather:result,cached:false }); }
  catch (error) { sendError(res, 502, error.message || "Could not reach Open-Meteo. Check the server's internet connection and try again."); }
});
app.get('/api/geocode/search', requireUser, async (req, res) => {
  const query = String(req.query.q || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 200) return sendError(res, 400, 'Enter at least 2 characters to search for a place.');
  const key = `search:${query.toLocaleLowerCase()}`, cached = GEO_CACHE.get(key);
  if (cached && cached.expires > Date.now()) return res.json(cached.value);
  try {
    const response = await fetch(`https://photon.komoot.io/api/?${new URLSearchParams({q:query,limit:'5',lang:'en'})}`, { signal:AbortSignal.timeout(8000),headers:{Accept:'application/json','User-Agent':`JibonGuard/1.0 (${PUBLIC_ORIGIN})`} });
    if (!response.ok) return sendError(res, 502, `Place search failed (HTTP ${response.status}). Try again shortly.`);
    const json = await response.json(), results = (json.features || []).flatMap(feature => {
      const [longitude,latitude] = feature.geometry?.coordinates || [], p = feature.properties || {};
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) return [];
      const name = String(p.name || p.street || p.city || '').trim(), address = [name,[p.housenumber,p.street].filter(Boolean).join(' '),p.postcode,p.city,p.district,p.county,p.state,p.country].filter(Boolean);
      return [{ latitude,longitude,name:name.slice(0,120),display_name:[...new Set(address)].join(', ').slice(0,500) }];
    });
    const value = { results }; GEO_CACHE.set(key,{expires:Date.now()+86400000,value}); res.json(value);
  } catch { sendError(res, 502, 'Could not retrieve place suggestions. Check your connection or select a point directly on the map.'); }
});
app.get('/api/geocode/reverse', requireUser, async (req, res) => {
  const latitude = Number(req.query.lat), longitude = Number(req.query.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) return sendError(res, 400, 'Choose a valid point on the map.');
  const key = `reverse:${latitude.toFixed(5)},${longitude.toFixed(5)}`, cached = GEO_CACHE.get(key);
  if (cached && cached.expires>Date.now()) return res.json(cached.value);
  try {
    const params=new URLSearchParams({format:'jsonv2',lat:String(latitude),lon:String(longitude),zoom:'18',addressdetails:'1'});
    const response=await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json','User-Agent':`JibonGuard/1.0 (site location picker; ${PUBLIC_ORIGIN})`,Referer:`${PUBLIC_ORIGIN}/dashboard.html`}});
    const result=await response.json(); if(!response.ok||!result.display_name)return sendError(res,response.status===404?404:502,'Could not retrieve this place from OpenStreetMap. You can still save the coordinates.');
    const address=result.address||{}, name=result.name||address.building||address.amenity||address.road||address.neighbourhood||address.suburb||address.village||address.town||address.city||'';
    const value={latitude,longitude,display_name:result.display_name,name:String(name).slice(0,120),address}; GEO_CACHE.set(key,{expires:Date.now()+604800000,value}); res.json(value);
  } catch { sendError(res, 502, 'Could not retrieve this place from OpenStreetMap. You can still save the coordinates.'); }
});

async function geminiGenerate(contents, instruction, jsonResponse = false) {
  if (!GEMINI_API_KEY) throw new Error('Gemini is not configured. Set GEMINI_API_KEY in the server .env file.');
  const generationConfig = { maxOutputTokens:700 };
  if (GEMINI_MODEL.startsWith('gemini-3')) generationConfig.thinkingConfig={thinkingLevel:GEMINI_MODEL==='gemini-3.5-flash-lite'?'minimal':'low'};
  if (jsonResponse) generationConfig.responseMimeType='application/json';
  let response;
  try { response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,{method:'POST',signal:AbortSignal.timeout(50000),headers:{'x-goog-api-key':GEMINI_API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:instruction}]},contents,generationConfig})}); }
  catch { throw new Error("Could not connect to Gemini. Check the server's internet connection."); }
  const result=await response.json().catch(()=>({}));
  if (!response.ok) { const detail=String(result.error?.message||'').replace(/\s+/g,' ').slice(0,240); throw new Error(`Gemini returned HTTP ${response.status}.${detail?` ${detail}`:' Check the server key, model and API quota.'}`); }
  const candidate=result.candidates?.[0]||{}, answer=(candidate.content?.parts||[]).map(part=>part.text||'').join('\n').trim();
  if (!answer) throw new Error(`Gemini returned no text${candidate.finishReason?` (${candidate.finishReason})`:''}. Check the model/key or rephrase the prompt.`);
  return answer;
}
app.post('/api/ai/chat', csrfAndOrigin, requireUser, async (req,res) => {
  if (!rateAllowed(req,'gemini-chat',20,3600)) return sendError(res,429,'Chat limit reached. Try again in a little while.');
  const messages=req.body.messages;
  if (!Array.isArray(messages)||!messages.length||messages.length>12) return sendError(res,400,'Send a short chat message and try again.');
  const contents=messages.slice(-10).filter(item=>item&&['user','model'].includes(item.role)&&typeof item.text==='string'&&item.text.trim()&&item.text.length<=1200).map(item=>({role:item.role,parts:[{text:item.text.trim()}]}));
  if (!contents.length||contents.at(-1).role!=='user') return sendError(res,400,'Enter a message to continue.');
  const instruction="You are JibonGuard's in-app assistant. Help organization administrators understand the dashboard, site weather, worker consent, break logs, and practical heat and weather safety. Be concise and clear. Do not claim to see private organization records or live weather unless supplied in the conversation. Never give a medical diagnosis or claim an emergency is safe; direct urgent situations to local emergency services and official instructions. Do not ask for passwords, API keys, or personal worker details.";
  try { res.json({ reply:await geminiGenerate(contents,instruction) }); } catch(error) { sendError(res,503,error.message); }
});

async function sendTextBeeBreakSms(recipients, record) {
  if (!recipients.length) return { status:'no_recipients',recipient_count:0,message:'No consented workers with usable phone numbers are assigned to this site.' };
  const apiKey=(process.env.TEXTBEE_API_KEY||process.env.TEXTBEE_DEV_API||'').trim(), subscription=(process.env.TEXTBEE_SIM_SUBSCRIPTION_ID||process.env.SIM_SUBSCRIPTION_ID||'').trim(), base=(process.env.TEXTBEE_BASE_URL||'https://api.textbee.dev/api/v1').replace(/\/$/,'');
  if (!apiKey) return {status:'not_configured',recipient_count:0,message:'Break saved, but SMS is not configured. Set TEXTBEE_API_KEY in JibonGuard AI/.env.'};
  if (subscription && !/^\d+$/.test(subscription)) return {status:'not_configured',recipient_count:0,message:'Break saved, but the configured TextBee SIM ID is invalid. Clear TEXTBEE_SIM_SUBSCRIPTION_ID to use the device default SIM.'};
  if (!base.startsWith('https://')) return {status:'not_configured',recipient_count:0,message:'Break saved, but SMS configuration must use an HTTPS TextBee API URL.'};
  const alertCopy={rain:"Rain Alert: Pause exposed outdoor work, move to a covered safe location, and avoid slippery or waterlogged areas. Follow your site's safety instructions. Worksite:",storm:'Storm Alert: Stop outdoor work and move to designated safe shelter, away from trees, electric poles, metal structures, and exposed areas. Follow official warnings. Worksite:',earthquake:'Earthquake Alert: Drop, cover, and hold on. Stay away from windows and heavy objects; evacuate only when shaking stops and follow site instructions. Worksite:'};
  const messages=recipients.map(recipient=>({recipients:[recipient.phone],message:alertCopy[record.alert_type]?`Hi ${recipient.name||'Worker'}, ${alertCopy[record.alert_type]} ${record.site}. - JibonGuard`:`Hi ${recipient.name||'Worker'}, break reminder: ${record.title} at ${record.site} on ${record.break_date} ${record.break_time} (${record.duration_minutes} min). - JibonGuard`,...(subscription?{simSubscriptionId:Number(subscription)}:{})}));
  try {
    const response=await fetch(`${base}/gateway/send-bulk-sms`,{method:'POST',signal:AbortSignal.timeout(20000),headers:{'x-api-key':apiKey,'Content-Type':'application/json',Accept:'application/json','User-Agent':'JibonGuard/1.0 (site break notifications)'},body:JSON.stringify({messages,messageTemplate:String(record.title||'JibonGuard alert').slice(0,100)})});
    const result=await response.json().catch(()=>({}));
    if (!response.ok) { const detail=String(result.message||result.error?.message||result.data?.message||'').replace(/\s+/g,' ').slice(0,180); return {status:'failed',recipient_count:0,message:response.status===401?'Break saved, but TextBee rejected the API key. Check TEXTBEE_API_KEY.':response.status===429?"Break saved, but TextBee's sending limit was reached.":`Break saved, but TextBee returned HTTP ${response.status}.${detail?` ${detail}`:' Check that a default device is enabled and online.'}`}; }
    const accepted=result.data?.success===true||Number(result.data?.successCount)>0;
    if (!accepted) { const failed=Number(result.data?.failureCount)||0; return {status:'failed',recipient_count:0,message:failed?`Break saved, but TextBee could not queue ${failed} SMS. Check device status and recipient numbers.`:'Break saved, but TextBee did not confirm the batch. Check that a default sending device is enabled and online.'}; }
    const acceptedCount=Number(result.data?.recipientCount||result.data?.successCount)||recipients.length;
    return {status:'queued',recipient_count:acceptedCount,message:`TextBee accepted ${acceptedCount} personalized SMS message(s) into its queue.`};
  } catch { return {status:'failed',recipient_count:0,message:'Break saved, but the TextBee request timed out or failed. Retry shortly.'}; }
}
function consentedRecipients(org, siteId) {
  const rows=db.prepare('SELECT name,phone FROM workers WHERE organization_id=? AND site_id=? AND consent_at IS NOT NULL').all(org,siteId), map=new Map();
  for (const row of rows) { const phone=normalizePhone(row.phone); if(phone&&!map.has(phone))map.set(phone,{phone,name:row.name}); }
  return [...map.values()];
}
app.post('/api/breaks',csrfAndOrigin,requireUser,async(req,res)=>{
  const d=req.body, alertType=String(d.alert_type||'break').trim(), title=BREAK_ALERTS[alertType]||String(d.title||'').trim(), siteId=String(d.site_id||'').trim(), date=String(d.break_date||'').trim(), time=String(d.break_time||'').trim(), status=String(d.status||'logged').trim(), duration=Number(d.duration_minutes);
  if (!['break','rain','storm','earthquake'].includes(alertType)||!title||title.length>120||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isInteger(duration)||duration<1||duration>240||!['logged','scheduled'].includes(status)) return sendError(res,400,'Enter a break name, site, valid date and time, and duration from 1 to 240 minutes.');
  const [year,month,day]=date.split('-').map(Number),validDate=new Date(Date.UTC(year,month-1,day));
  if(validDate.getUTCFullYear()!==year||validDate.getUTCMonth()!==month-1||validDate.getUTCDate()!==day)return sendError(res,400,'Enter a valid break date.');
  const site=db.prepare('SELECT name FROM sites WHERE id=? AND organization_id=?').get(siteId,req.user.organization_id);
  if (!site) return sendError(res,400,'Choose a worksite from your saved Sites list.');
  const recipients=consentedRecipients(req.user.organization_id,siteId), workerCount=db.prepare('SELECT COUNT(*) AS count FROM workers WHERE organization_id=?').get(req.user.organization_id).count,id=token(12),stamp=now();
  db.prepare(`INSERT INTO break_logs(id,organization_id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'manual',?,'',?)`).run(id,req.user.organization_id,title,site.name,date,time,duration,workerCount,status,alertType,stamp);
  const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=?').get(id);
  res.status(201).json({break:record,sms:await sendTextBeeBreakSms(recipients,record)});
});
app.put('/api/breaks',csrfAndOrigin,requireUser,(req,res)=>{
  const id=String(req.query.id||'').trim();
  if(!id)return sendError(res,400,'Choose a break log to update.');
  const existing=db.prepare('SELECT id,source FROM break_logs WHERE id=? AND organization_id=?').get(id,req.user.organization_id);
  if(!existing)return sendError(res,404,'Break log not found.');
  if(existing.source!=='manual')return sendError(res,403,'AI-created safety logs are read-only.');
  const d=req.body,alertType=String(d.alert_type||'break').trim(),title=BREAK_ALERTS[alertType]||String(d.title||'').trim(),siteId=String(d.site_id||'').trim(),date=String(d.break_date||'').trim(),time=String(d.break_time||'').trim(),status=String(d.status||'logged').trim(),duration=Number(d.duration_minutes);
  if(!['break','rain','storm','earthquake'].includes(alertType)||!title||title.length>120||!/^(\d{4})-(\d{2})-(\d{2})$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isInteger(duration)||duration<1||duration>240||!['logged','scheduled'].includes(status))return sendError(res,400,'Enter a valid action, worksite, date, time, and duration from 1 to 240 minutes.');
  const [year,month,day]=date.split('-').map(Number),validDate=new Date(Date.UTC(year,month-1,day));
  if(validDate.getUTCFullYear()!==year||validDate.getUTCMonth()!==month-1||validDate.getUTCDate()!==day)return sendError(res,400,'Enter a valid break date.');
  const site=db.prepare('SELECT name FROM sites WHERE id=? AND organization_id=?').get(siteId,req.user.organization_id);
  if(!site)return sendError(res,400,'Choose a worksite from your saved Sites list.');
  const workerCount=db.prepare('SELECT COUNT(*) AS count FROM workers WHERE organization_id=?').get(req.user.organization_id).count;
  db.prepare('UPDATE break_logs SET title=?,site=?,break_date=?,break_time=?,duration_minutes=?,worker_count=?,status=?,alert_type=? WHERE id=? AND organization_id=? AND source=\'manual\'').run(title,site.name,date,time,duration,workerCount,status,alertType,id,req.user.organization_id);
  const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=? AND organization_id=?').get(id,req.user.organization_id);
  res.json({break:record});
});
app.post('/api/breaks/ai-schedule',csrfAndOrigin,requireUser,async(req,res)=>{
  if (!rateAllowed(req,'gemini-schedule',4,3600)) return sendError(res,429,'AI scheduling limit reached. Try again later.');
  if (!GEMINI_API_KEY) return sendError(res,503,'Gemini is not configured. Set GEMINI_API_KEY in JibonGuard AI/.env and restart the server.');
  const sites=db.prepare('SELECT id,name,address,latitude,longitude FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE LIMIT 20').all(req.user.organization_id);
  if (!sites.length) return sendError(res,422,'Add a saved worksite with map coordinates before asking AI to schedule breaks.');
  if (!sites.some(site=>site.latitude!=null&&site.longitude!=null)) return sendError(res,422,'Add latitude and longitude to at least one saved worksite before AI scheduling.');
  const pending=[], errors=[];
  for (const site of sites.filter(item=>item.latitude!=null&&item.longitude!=null)) {
    try {
      const weather=await openMeteo(site),current=weather.current,hourly=weather.hourly||{},forecast=(hourly.time||[]).slice(0,24).filter((_,i)=>i%2===0).map((time,i)=>({time,temperature_c:(hourly.temperature_2m||[])[i*2],feels_like_c:(hourly.apparent_temperature||[])[i*2],rain_probability_percent:(hourly.precipitation_probability||[])[i*2],weather_code:(hourly.weather_code||[])[i*2],wind_speed_m_s:(hourly.wind_speed_10m||[])[i*2]}));
      const context={site:site.name,address:site.address,timezone:weather.timezone||'UTC',current:{temperature_2m:current.temperature_2m,apparent_temperature:current.apparent_temperature,relative_humidity_2m:current.relative_humidity_2m,precipitation:current.precipitation,weather_code:current.weather_code,wind_speed_10m:current.wind_speed_10m,wind_gusts_10m:current.wind_gusts_10m},next_hours:forecast};
      const instruction='Recommend at most one safety log using only supplied Open-Meteo data. Return JSON with action (schedule or no_schedule), alert_type (break, rain, or storm), duration_minutes (10, 15, or 20), rationale (under 35 words). Use storm for thunderstorms or dangerous wind, rain for substantial rain risk, and a routine water/shade break for dangerous heat. Choose no_schedule only when no safety action is warranted. Never invent observations.';
      const decision=JSON.parse(await geminiGenerate([{role:'user',parts:[{text:JSON.stringify(context)}]}],instruction,true));
      const code=Number(current.weather_code),gusts=Number(current.wind_gusts_10m),apparent=Number(current.apparent_temperature),maxRain=Math.max(0,...forecast.map(item=>Number(item.rain_probability_percent)||0));
      if([95,96,99].includes(code)||gusts>=20)Object.assign(decision,{action:'schedule',alert_type:'storm'});else if(maxRain>=70)Object.assign(decision,{action:'schedule',alert_type:'rain'});else if(apparent>=35)Object.assign(decision,{action:'schedule',alert_type:'break'});
      if(decision.action!=='schedule'||!['break','rain','storm'].includes(decision.alert_type))continue;
      const stamp=String(current.time||new Date().toISOString()).slice(0,16),localClock=new Date(`${stamp}:00Z`),scheduled=new Date(localClock);scheduled.setUTCMinutes(0,0,0);if(scheduled<=new Date(localClock.getTime()+1200000))scheduled.setUTCHours(scheduled.getUTCHours()+1);while(scheduled.getUTCHours()%2)scheduled.setUTCHours(scheduled.getUTCHours()+1);
      pending.push({site,title:BREAK_ALERTS[decision.alert_type],alert_type:decision.alert_type,duration:[10,15,20].includes(Number(decision.duration_minutes))?Number(decision.duration_minutes):15,rationale:String(decision.rationale||'Weather safety break recommended.').replace(/\s+/g,' ').slice(0,300),date:scheduled.toISOString().slice(0,10),time:`${String(scheduled.getUTCHours()).padStart(2,'0')}:${String(scheduled.getUTCMinutes()).padStart(2,'0')}`});
    }catch(error){console.error(`AI schedule skipped ${site.id}: ${error.name}`);errors.push(error.message);}
  }
  if (!pending.length) { if(errors.length)return sendError(res,502,errors[0]); return res.json({created:[],message:'AI found no suitable weather-based break to schedule, or weather/Gemini was unavailable.'}); }
  const created=[],jobs=[];let already=0,workerCount=db.prepare('SELECT COUNT(*) AS count FROM workers WHERE organization_id=?').get(req.user.organization_id).count;
  for(const item of pending){const duplicate=db.prepare("SELECT 1 FROM break_logs WHERE organization_id=? AND site=? AND break_date=? AND break_time=? AND source='ai' LIMIT 1").get(req.user.organization_id,item.site.name,item.date,item.time);if(duplicate){already++;continue;}const id=token(12);db.prepare(`INSERT INTO break_logs(id,organization_id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at) VALUES(?,?,?,?,?,?,?,?, 'scheduled','ai',?,?,?)`).run(id,req.user.organization_id,item.title,item.site.name,item.date,item.time,item.duration,workerCount,item.alert_type,item.rationale,now());const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=?').get(id);created.push(record);jobs.push(sendTextBeeBreakSms(consentedRecipients(req.user.organization_id,item.site.id),record));}
  const sms=await Promise.all(jobs),suffix=already?` ${already} matching AI log(s) already existed.`:'';
  res.status(201).json({created,sms,message:`AI scheduled ${created.length} weather-based break log(s).${suffix}`});
});

app.use('/api', (req, res) => sendError(res, 404, 'Not found.'));
{
  const dist = path.join(__dirname, 'dist');
  if (IS_PRODUCTION || existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
}
app.use((error, req, res, next) => {
  console.error(`${req.method} ${req.path}: ${error.name}`);
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.too.large' ? 413 : 500;
  sendError(res, status, status === 413 ? 'The submitted data is too large.' : 'The request could not be completed right now. Please try again later.');
});
app.listen(PORT, HOST, () => console.log(`JibonGuard Node server listening at http://${HOST}:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`));




