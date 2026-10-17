import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { PostgresSyncDatabase } from './server/db/postgresSync.js';
import { createHash, createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAlertConfig } from './server/alerts/config.js';
import { decideAlerts } from './server/alerts/index.js';
import { renderAlertTemplate } from './server/alerts/templates.js';
import { dispatchAlertGroups } from './server/alerts/gateway.js';
import { runMigrations } from './server/db/migrations.js';
import { applyPlanCatalogMigration } from './server/billing/planCatalog.js';
import { createJobRunner } from './server/jobs/runner.js';
import { writeAdminAudit } from './server/billing/audit.js';
import { hasPermission } from './server/billing/permissions.js';
import { FEATURE_KEYS } from './server/billing/features.js';
import { createMeteringService, estimateGeminiTokens } from './server/billing/metering.js';
import { calculateSmsSegments } from './server/billing/smsSegments.js';
import { rebuildUsageRollups } from './server/billing/rollups.js';
import { checkFeatureAccess, checkResourceLimit, checkUsageDispatch, getOrganizationEntitlements } from './server/billing/entitlements.js';
import { canTransitionSubscription } from './server/billing/subscriptionState.js';
import { processBillingLifecycle } from './server/billing/lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of (existsSync(path.join(__dirname, '.env')) ? readFileSync(path.join(__dirname, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match && !match[1].startsWith('#') && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const ALERT_CONFIG = loadAlertConfig();

const app = express();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = (process.env.APP_ENV || 'development').toLowerCase() === 'production';
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://${HOST}:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE = 'jg_session';
const CSRF_COOKIE = 'jg_csrf';
const ADMIN_SESSION_COOKIE = 'jg_admin_session';
const ADMIN_CSRF_COOKIE = 'jg_admin_csrf';
const SESSION_LIFETIME = 12 * 60 * 60;
const REMEMBER_LIFETIME = 30 * 24 * 60 * 60;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const TOKEN_LIFETIME = 60 * 60;
const PLAN_LIMIT_KEYS = new Set(['workers','sites','users','sms_segments_month','ai_tokens_month','voice_minutes_month','weather_checks_month','retention_days']);
const ADMIN_SESSION_LIFETIME = Math.min(8 * 60 * 60, Math.max(600, Number(process.env.ADMIN_SESSION_LIFETIME_SECONDS || 3600)));
const PASSWORD_MIN = 12;
const DB_PATH = process.env.JIBONGUARD_DB || path.join(__dirname, 'jibonguard.sqlite3');
const USING_POSTGRES = Boolean(process.env.DATABASE_URL);
const now = () => Math.floor(Date.now() / 1000);
const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
if (IS_PRODUCTION && SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
if (IS_PRODUCTION && (!PUBLIC_ORIGIN.startsWith('https://') || !new URL(PUBLIC_ORIGIN).host || new URL(PUBLIC_ORIGIN).pathname !== '/')) throw new Error('Set PUBLIC_ORIGIN to the exact production HTTPS origin.');
if (IS_PRODUCTION && (!process.env.SMTP_HOST || !(process.env.SMTP_FROM || process.env.SMTP_USER))) throw new Error('Set SMTP_HOST and SMTP_FROM (or SMTP_USER) in production.');
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
const GEMINI_TTS_MODEL = (process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts').trim();
const OPEN_METEO_API_KEY = (process.env.OPEN_METEO_API_KEY || '').trim();
const BREAK_ALERTS = { break: 'Water and shade break', rain: 'Rain safety alert', storm: 'Storm safety alert', earthquake: 'Earthquake safety alert' };
const BANGLA_DIGITS = '\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef';
const toAsciiDigits = value => String(value || '').replace(/[\u09e6-\u09ef]/g, digit => String(BANGLA_DIGITS.indexOf(digit)));
const scrypt = promisify(scryptCb);
const db = USING_POSTGRES ? new PostgresSyncDatabase(process.env.DATABASE_URL) : new DatabaseSync(DB_PATH);
if (!USING_POSTGRES) {
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');

db.exec(`
CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,organization_type TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',estimated_workers INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,full_name TEXT NOT NULL,email TEXT NOT NULL COLLATE NOCASE UNIQUE,phone TEXT NOT NULL,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('organization_owner')),email_verified_at INTEGER,privacy_notice_version TEXT NOT NULL,privacy_consent_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS action_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_otp_challenges(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,purpose TEXT NOT NULL CHECK(purpose IN ('signup','login')),otp_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,remember INTEGER NOT NULL DEFAULT 0,next_path TEXT NOT NULL DEFAULT '/dashboard.html',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_otp_user_idx ON auth_otp_challenges(user_id,purpose,created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id); CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at); CREATE INDEX IF NOT EXISTS action_tokens_user_idx ON action_tokens(user_id);
CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,name TEXT NOT NULL,phone TEXT NOT NULL,site TEXT NOT NULL,job_type TEXT NOT NULL,workload TEXT NOT NULL DEFAULT 'Standard',risk_level TEXT NOT NULL DEFAULT 'Moderate',outdoor_minutes INTEGER NOT NULL DEFAULT 0,last_break TEXT NOT NULL DEFAULT '',consent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,name TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',latitude REAL,longitude REAL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(organization_id,name));
CREATE TABLE IF NOT EXISTS worker_consent_events(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,action TEXT NOT NULL CHECK(action IN ('consented','withdrawn')),method TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',changed_by TEXT NOT NULL,changed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS consent_worker_idx ON worker_consent_events(organization_id,worker_id,changed_at DESC); CREATE INDEX IF NOT EXISTS workers_org_idx ON workers(organization_id,created_at);
CREATE TABLE IF NOT EXISTS break_logs(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,title TEXT NOT NULL,site TEXT NOT NULL,break_date TEXT NOT NULL,break_time TEXT NOT NULL,duration_minutes INTEGER NOT NULL,worker_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'logged' CHECK(status IN ('logged','scheduled')),source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),alert_type TEXT NOT NULL DEFAULT 'break',ai_rationale TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS break_logs_org_idx ON break_logs(organization_id,break_date DESC,break_time DESC);
CREATE TABLE IF NOT EXISTS scheduled_break_sms(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,break_id TEXT NOT NULL REFERENCES break_logs(id) ON DELETE CASCADE,worker_id TEXT,workload TEXT NOT NULL DEFAULT '',recipient TEXT NOT NULL,message TEXT NOT NULL,scheduled_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sending','sent','failed')),created_at INTEGER NOT NULL,sent_at INTEGER,error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS scheduled_break_sms_due_idx ON scheduled_break_sms(status,scheduled_at);
CREATE TABLE IF NOT EXISTS sms_messages(id TEXT NOT NULL,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,direction TEXT NOT NULL CHECK(direction IN ('sent','received')),sender TEXT NOT NULL DEFAULT '',recipient TEXT NOT NULL DEFAULT '',message TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'unknown',device_name TEXT NOT NULL DEFAULT '',message_at TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(organization_id,id));
CREATE INDEX IF NOT EXISTS sms_messages_org_date_idx ON sms_messages(organization_id,message_at DESC);
CREATE TABLE IF NOT EXISTS sms_sync_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_settings(organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,settings_json TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 0,ai_enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS automated_alerts(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,event_key TEXT NOT NULL,alert_type TEXT NOT NULL,channel TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,scheduled_at INTEGER NOT NULL,created_at INTEGER NOT NULL,sent_at INTEGER,reason TEXT NOT NULL,input_hash TEXT NOT NULL,model_output TEXT NOT NULL DEFAULT '',input_context TEXT NOT NULL DEFAULT '{}',variables TEXT NOT NULL DEFAULT '{}',message TEXT NOT NULL DEFAULT '',floor INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS automated_alerts_org_day_idx ON automated_alerts(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS automated_alerts_dispatch_idx ON automated_alerts(status,scheduled_at);
`);
for (const [table, column, declaration] of [
  ['workers', 'site_id', 'TEXT'], ['workers', 'consent_method', "TEXT NOT NULL DEFAULT ''"],
  ['workers', 'shift_start', "TEXT NOT NULL DEFAULT '07:00'"], ['workers', 'shift_end', "TEXT NOT NULL DEFAULT '17:00'"], ['workers', 'age_group', "TEXT NOT NULL DEFAULT ''"], ['workers', 'has_personal_risk_factor', 'INTEGER NOT NULL DEFAULT 0'],
  ['sites', 'shade_available', 'INTEGER NOT NULL DEFAULT 0'], ['sites', 'water_available', 'INTEGER NOT NULL DEFAULT 0'], ['sites', 'rest_area', 'INTEGER NOT NULL DEFAULT 0'],
  ['break_logs', 'source', "TEXT NOT NULL DEFAULT 'manual'"], ['break_logs', 'alert_type', "TEXT NOT NULL DEFAULT 'break'"], ['break_logs', 'ai_rationale', "TEXT NOT NULL DEFAULT ''"], ['break_logs', 'workload_levels', "TEXT NOT NULL DEFAULT '[]'"],
  ['scheduled_break_sms', 'worker_id', 'TEXT'], ['scheduled_break_sms', 'workload', "TEXT NOT NULL DEFAULT ''"],
  ['sms_messages', 'emergency_status', "TEXT NOT NULL DEFAULT ''"],
]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
}
const retiredWorkload=['Very','Heavy'].join(' ');
db.prepare("UPDATE workers SET workload='Heavy' WHERE workload=?").run(retiredWorkload);
db.prepare("UPDATE scheduled_break_sms SET workload='Heavy' WHERE workload=?").run(retiredWorkload);
for(const row of db.prepare('SELECT id,workload_levels FROM break_logs').all()){
  try{const levels=JSON.parse(row.workload_levels||'[]');if(Array.isArray(levels)&&levels.includes(retiredWorkload)){const normalized=[...new Set(levels.map(level=>level===retiredWorkload?'Heavy':level).filter(level=>['Light','Standard','Heavy'].includes(level)))];db.prepare('UPDATE break_logs SET workload_levels=? WHERE id=?').run(JSON.stringify(normalized),row.id);}}catch{}
}
if (!USING_POSTGRES) runMigrations(db, { databasePath: DB_PATH, development: !IS_PRODUCTION });
applyPlanCatalogMigration(db);
const jobRunner = createJobRunner({ db });
const metering = createMeteringService(db, { logger: console, defaultCurrency: 'BDT' });
const USAGE_ROLLUP_INTERVAL_MS=Math.max(60000,Number(process.env.BILLING_ROLLUP_INTERVAL_MS||86400000));
const BILLING_LIFECYCLE_INTERVAL_MS=Math.max(60000,Number(process.env.BILLING_LIFECYCLE_INTERVAL_MS||3600000));
jobRunner.register('usage_rollups',()=>rebuildUsageRollups(db));
jobRunner.register('billing_lifecycle',()=>runBillingLifecycle());
db.prepare("UPDATE sms_messages SET emergency_status='historic' WHERE direction='received' AND emergency_status=''").run();
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
const ALERT_WEATHER_CACHE = new Map();
const ALERT_WEATHER_STATUS = new Map();
const SITE_TIMEZONES = new Map();
const hashToken = value => SESSION_SECRET ? createHmac('sha256', SESSION_SECRET).update(value).digest('hex') : createHash('sha256').update(value).digest('hex');
function issueAuthOtp(userId,purpose,remember=false,nextPath='/dashboard.html') {
  const id=token(24),code=String(randomInt(0,1_000_000)).padStart(6,'0'),stamp=now();
  db.prepare('DELETE FROM auth_otp_challenges WHERE user_id=? AND purpose=?').run(userId,purpose);
  db.prepare('INSERT INTO auth_otp_challenges(id,user_id,purpose,otp_hash,expires_at,attempts,remember,next_path,created_at) VALUES(?,?,?,?,?,0,?,?,?)').run(id,userId,purpose,hashToken(`${id}:${code}`),stamp+600,remember?1:0,safeNext(nextPath),stamp);
  return {challengeId:id,code};
}
async function emailAuthOtp(user,challenge,purpose) {
  const action=purpose==='signup'?'verify your email and finish creating your account':'finish signing in';
  await sendEmail(user.email,purpose==='signup'?'Verify your JibonGuard account':'Your JibonGuard sign-in code',`Hello ${user.full_name},\n\nYour one-time code to ${action} is: ${challenge.code}\n\nThis code expires in 10 minutes. If you did not request it, you can ignore this email.`);
}
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
let nextAuthCleanupAt = 0;
const sessionUser = req => {
  const opaque = parseCookies(req)[SESSION_COOKIE];
  if (!opaque) return null;
  const stamp = now();
  if (stamp >= nextAuthCleanupAt) {
    nextAuthCleanupAt = stamp + 300;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(stamp);
    db.prepare('DELETE FROM action_tokens WHERE expires_at < ?').run(stamp);
  }
  return db.prepare(`SELECT u.id,u.organization_id,u.full_name,u.email,u.phone,u.role,o.name AS organization_name,o.organization_type
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.organization_id
    WHERE s.token_hash=? AND s.expires_at>=?`).get(hashToken(opaque), stamp) || null;
};
const csrfToken = req => {
  const existing = parseCookies(req)[CSRF_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing)) return { value: existing, set: false };
  return { value: token(32), set: true };
};
const validRequestOrigin = req => {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const requestHosts = [req.get('x-forwarded-host'), req.get('host')]
      .flatMap(value => String(value || '').split(','))
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    const matchesRequestHost = requestHosts.includes(parsed.host.toLowerCase());
    const matchesConfiguredOrigin = parsed.origin === PUBLIC_ORIGIN;
    const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    if (!matchesRequestHost && !matchesConfiguredOrigin) return false;
    if (IS_PRODUCTION) return parsed.protocol === 'https:' && (!forwardedProtocol || forwardedProtocol === 'https');
    return /^https?:$/.test(parsed.protocol);
  } catch { return false; }
};
const csrfAndOrigin = (req, res, next) => {
  const cookies = parseCookies(req), header = req.get('x-csrf-token') || '';
  if (!validRequestOrigin(req)) return sendError(res, 403, 'Request origin could not be verified. Reload the page and try again.');
  if (!cookies[CSRF_COOKIE] || !header || cookies[CSRF_COOKIE] !== header) return sendError(res, 403, 'Your security token expired. Reload the page and try again.');
  next();
};
const requireUser = (req, res, next) => {
  req.user = sessionUser(req);
  if (!req.user) return sendError(res, 401, 'Sign in to continue.');
  next();
};
const requirePlanFeature = feature => (req,res,next) => {
  const access=checkFeatureAccess(db,req.user.organization_id,feature);
  if(feature==='data_export'&&access.status==='suspended')return next();
  if(access.allowed)return next();
  return res.status(402).json({error:'This feature is not included in your current plan.',code:'PLAN_FEATURE_REQUIRED',feature,plan_id:access.planId,status:access.status,billing_url:'/billing'});
};
const enforceResourceLimit = (req,res,key,current,adding=1) => {
  const result=checkResourceLimit(db,req.user.organization_id,key,current,adding);
  if(result.allowed)return true;
  sendError(res,402,`Your plan's ${key} limit would be exceeded. Review your plan or remove existing resources.`);
  return false;
};
const adminSessionUser = req => {
  const opaque = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (!opaque) return null;
  const stamp = now();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at<?').run(stamp);
  return db.prepare(`SELECT a.id,a.email,a.role,a.totp_enabled,a.totp_required,s.expires_at,s.reauth_at
    FROM admin_sessions s JOIN admin_users a ON a.id=s.admin_id
    WHERE s.token_hash=? AND s.expires_at>=? AND a.disabled_at IS NULL`).get(hashToken(opaque), stamp) || null;
};
const adminIpAllowed = req => {
  const configured = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map(value => value.trim()).filter(Boolean);
  return !configured.length || configured.includes(req.ip || req.socket.remoteAddress || '');
};
const adminCsrfAndOrigin = (req,res,next) => {
  const cookies=parseCookies(req),header=req.get('x-csrf-token')||'';
  if(!validRequestOrigin(req))return sendError(res,403,'Request origin could not be verified.');
  if(!cookies[ADMIN_CSRF_COOKIE]||!header||cookies[ADMIN_CSRF_COOKIE]!==header)return sendError(res,403,'Admin security token expired. Reload the page and try again.');
  next();
};
const loadAdmin = (req,res,next) => {
  if(!adminIpAllowed(req))return sendError(res,403,'Admin access is not allowed from this network.');
  req.admin=adminSessionUser(req);
  if(!req.admin)return sendError(res,401,'Admin sign-in is required.');
  next();
};
const requireAdmin=(req,res,next)=>loadAdmin(req,res,next);
const adminPermission=permission=>(req,res,next)=>{
  if(!req.admin)return sendError(res,401,'Admin sign-in is required.');
  if(!hasPermission(req.admin.role,permission))return sendError(res,403,'This admin role cannot perform that action.');
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
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => { if (!req.path.startsWith('/api/')) console.log(`${req.method} ${req.path}`); next(); });

app.get('/api/admin/auth/csrf',(req,res)=>{
  const cookies=parseCookies(req),existing=cookies[ADMIN_CSRF_COOKIE];
  const value=existing&&/^[A-Za-z0-9_-]{32,64}$/.test(existing)?existing:token(32);
  if(value!==existing)res.cookie(ADMIN_CSRF_COOKIE,value,cookieOptions(false,ADMIN_SESSION_LIFETIME));
  res.set('Cache-Control','no-store').json({csrf_token:value});
});
app.post('/api/admin/auth/signup',adminCsrfAndOrigin,async(req,res)=>{
  if(!adminIpAllowed(req))return sendError(res,403,'Admin access is not allowed from this network.');
  if(!rateAllowed(req,'admin-signup',5,3600))return sendError(res,429,'Too many admin sign-up attempts. Try again later.');
  const configuredKey=String(process.env.ADMIN_SIGNUP_KEY||''),providedKey=typeof req.body.private_key==='string'?req.body.private_key:'';
  if(configuredKey.length<32)return sendError(res,503,'Admin sign-up is disabled. Configure a private ADMIN_SIGNUP_KEY of at least 32 characters on the server.');
  const expectedKey=createHash('sha256').update(configuredKey).digest(),actualKey=createHash('sha256').update(providedKey).digest();
  if(!providedKey||!timingSafeEqual(expectedKey,actualKey))return sendError(res,401,'The private key was not accepted.');
  const email=String(req.body.email||'').trim().toLowerCase(),password=req.body.password;
  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof password!=='string'||password.length<PASSWORD_MIN||password.length>128)return sendError(res,400,`Enter a valid email and a password between ${PASSWORD_MIN} and 128 characters.`);
  if(db.prepare('SELECT 1 FROM admin_users WHERE email=? COLLATE NOCASE').get(email))return sendError(res,409,'An admin account already uses this email.');
  const id=token(18),stamp=now(),{passwordHash,passwordSalt}=await hashPassword(password);
  try{
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO admin_users(id,email,password_hash,password_salt,role,totp_required,created_at,updated_at) VALUES(?,?,?,?,'super_admin',0,?,?)").run(id,email,passwordHash,passwordSalt,stamp,stamp);
    writeAdminAudit(db,{adminId:id,role:'super_admin',action:'admin.signup_created',targetType:'admin_user',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',after:{email},now:stamp});
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return sendError(res,409,'An admin account already uses this email.');throw error;}
  res.status(201).set('Cache-Control','no-store').json({created:true,message:'Admin account created. Sign in with your email and password.'});
});
app.post('/api/admin/auth/login',adminCsrfAndOrigin,async(req,res)=>{
  if(!adminIpAllowed(req))return sendError(res,403,'Admin access is not allowed from this network.');
  if(!rateAllowed(req,'admin-login',8,900))return sendError(res,429,'Too many admin sign-in attempts. Try again later.');
  const email=String(req.body.email||'').trim().toLowerCase(),password=req.body.password;
  if(email.length>254||!/^\S+@\S+\.\S+$/.test(email)||typeof password!=='string'||password.length>128)return sendError(res,400,'Enter a valid email and password.');
  const address=req.ip||req.socket.remoteAddress||'unknown',stamp=now();
  const failures=db.prepare('SELECT COUNT(*) AS n FROM admin_login_attempts WHERE email=? AND ip=? AND success=0 AND created_at>?').get(email,address,stamp-900).n;
  if(failures>=5)return sendError(res,429,'Admin sign-in is temporarily locked. Try again later.');
  const admin=db.prepare('SELECT * FROM admin_users WHERE email=? COLLATE NOCASE AND disabled_at IS NULL').get(email);
  const valid=Boolean(admin&&await checkPassword(password,admin.password_hash,admin.password_salt));
  db.prepare('INSERT INTO admin_login_attempts(id,email,ip,success,created_at) VALUES(?,?,?,?,?)').run(token(16),email,address,valid?1:0,stamp);
  if(!valid)return sendError(res,401,'Email or password was not accepted.');
  const opaque=token(32),lifetime=ADMIN_SESSION_LIFETIME;
  db.prepare('INSERT INTO admin_sessions(token_hash,admin_id,created_at,expires_at,ip,user_agent,reauth_at) VALUES(?,?,?,?,?,?,?)').run(hashToken(opaque),admin.id,stamp,stamp+lifetime,address,String(req.get('user-agent')||'').slice(0,300),null);
  writeAdminAudit(db,{adminId:admin.id,role:admin.role,action:'admin.login',targetType:'admin_user',targetId:admin.id,ip:address,userAgent:req.get('user-agent')||'',after:{success:true},now:stamp});
  res.cookie(ADMIN_SESSION_COOKIE,opaque,cookieOptions(true,lifetime));
  res.set('Cache-Control','no-store').json({authenticated:true,admin:{id:admin.id,email:admin.email,role:admin.role}});
});
app.get('/api/admin/auth/me',(req,res)=>{
  if(!adminIpAllowed(req))return sendError(res,403,'Admin access is not allowed from this network.');
  const admin=adminSessionUser(req);
  if(!admin)return sendError(res,401,'Admin sign-in is required.');
  res.set('Cache-Control','no-store').json({authenticated:true,admin:{id:admin.id,email:admin.email,role:admin.role}});
});
app.post('/api/admin/auth/logout',adminCsrfAndOrigin,requireAdmin,(req,res)=>{
  db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hashToken(parseCookies(req)[ADMIN_SESSION_COOKIE]));
  writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'admin.logout',targetType:'admin_user',targetId:req.admin.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',now:now()});
  res.clearCookie(ADMIN_SESSION_COOKIE,cookieOptions(true,0));res.json({ok:true});
});
app.post('/api/admin/auth/change-password',adminCsrfAndOrigin,requireAdmin,async(req,res)=>{
  const {current_password:currentPassword,new_password:newPassword,confirm_password:confirmPassword}=req.body||{};
  if(typeof currentPassword!=='string'||typeof newPassword!=='string'||newPassword.length<PASSWORD_MIN||newPassword.length>128)return sendError(res,400,`Enter your current password and a new password between ${PASSWORD_MIN} and 128 characters.`);
  if(newPassword!==confirmPassword)return sendError(res,400,'The new password and confirmation do not match.');
  const row=db.prepare('SELECT password_hash,password_salt FROM admin_users WHERE id=? AND disabled_at IS NULL').get(req.admin.id);
  if(!row||!(await checkPassword(currentPassword,row.password_hash,row.password_salt)))return sendError(res,401,'Current password did not match.');
  if(await checkPassword(newPassword,row.password_hash,row.password_salt))return sendError(res,400,'Choose a password different from your current one.');
  const {passwordHash,passwordSalt}=await hashPassword(newPassword),stamp=now(),sessionHash=hashToken(parseCookies(req)[ADMIN_SESSION_COOKIE]);
  db.prepare('UPDATE admin_users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(passwordHash,passwordSalt,stamp,req.admin.id);
  db.prepare('DELETE FROM admin_sessions WHERE admin_id=? AND token_hash<>?').run(req.admin.id,sessionHash);
  db.prepare('UPDATE admin_sessions SET reauth_at=? WHERE token_hash=?').run(stamp,sessionHash);
  writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'admin.password_changed',targetType:'admin_user',targetId:req.admin.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',now:stamp});
  res.json({ok:true});
});
app.get('/api/admin/overview',requireAdmin,adminPermission('dashboard_read'),(req,res)=>{
  const stamp=now(),day=new Date(stamp*1000);day.setUTCHours(0,0,0,0);const start=Math.floor(day.getTime()/1000);
  const counts=table=>Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n||0);
  const currentPlanPrices=db.prepare("SELECT s.billing_cycle,COALESCE((SELECT pp.amount_minor FROM plan_prices pp WHERE pp.plan_id=s.plan_id AND pp.billing_cycle=s.billing_cycle ORDER BY pp.effective_from DESC,pp.version DESC LIMIT 1),s.price_minor) AS current_price_minor FROM subscriptions s WHERE s.status IN ('active','trialing')").all();
  const mrr=currentPlanPrices.reduce((sum,row)=>sum+(row.billing_cycle==='yearly'?Math.round(row.current_price_minor/12):row.current_price_minor),0);
  const todayUsage=db.prepare('SELECT event_type,SUM(quantity) AS quantity,SUM(cost_minor) AS cost_minor FROM usage_events WHERE created_at>=? GROUP BY event_type').all(start);
  const usage=Object.fromEntries(todayUsage.map(row=>[row.event_type,{quantity:Number(row.quantity||0),cost_minor:Number(row.cost_minor||0)}]));
  const monthStart=Math.floor(Date.UTC(new Date(stamp*1000).getUTCFullYear(),new Date(stamp*1000).getUTCMonth(),1)/1000),finance=hasPermission(req.admin.role,'billing_read')?(()=>{const cash=Number(db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM payments WHERE status='succeeded' AND currency='BDT' AND verified_at>=? AND verified_at<?").get(monthStart,stamp).n||0),refunds=Number(db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM refunds WHERE currency='BDT' AND created_at>=? AND created_at<?").get(monthStart,stamp).n||0),cost=Number(db.prepare("SELECT COALESCE(SUM(cost_minor),0) AS n FROM usage_events WHERE currency='BDT' AND created_at>=? AND created_at<?").get(monthStart,stamp).n||0),expense=Number(db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM expenses WHERE currency='BDT' AND expense_date>=date(?,'unixepoch') AND expense_date<=date(?,'unixepoch')").get(monthStart,stamp).n||0);return {revenue_minor:mrr,cash_collected_minor:cash,refunds_minor:refunds,provider_cost_minor:cost,expenses_minor:expense,profit_minor:mrr-refunds-cost-expense};})():null;
  res.set('Cache-Control','no-store').json({organizations:counts('organizations'),workers:counts('workers'),sites:counts('sites'),alerts_today:Number(db.prepare('SELECT COUNT(*) AS n FROM automated_alerts WHERE created_at>=?').get(start).n||0),subscriptions_active:Number(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status='active'").get().n||0),subscriptions_trialing:Number(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status='trialing'").get().n||0),subscriptions_past_due:Number(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status='past_due'").get().n||0),mrr_minor:mrr,currency:'BDT',usage_today:usage,finance});
});
app.get('/api/admin/system/health',requireAdmin,adminPermission('dashboard_read'),(_req,res)=>{
  const jobs=db.prepare(`SELECT j.id,j.organization_id,j.job_key,j.status,j.started_at,j.finished_at,j.error_code,o.name AS organization_name FROM job_runs j LEFT JOIN organizations o ON o.id=j.organization_id ORDER BY j.started_at DESC LIMIT 100`).all();
  const aiCalls=db.prepare(`SELECT a.id,a.organization_id,a.feature,a.prompt_version,a.ok,a.fallback,a.latency_ms,a.created_at,o.name AS organization_name FROM ai_calls a LEFT JOIN organizations o ON o.id=a.organization_id ORDER BY a.created_at DESC LIMIT 100`).all();
  res.set('Cache-Control','no-store').json({jobs,ai_calls:aiCalls});
});
app.get('/api/admin/organizations',requireAdmin,adminPermission('organizations_read'),(req,res)=>{
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||25)),offset=Math.max(0,Number.parseInt(req.query.offset,10)||0),search=String(req.query.q||'').trim().slice(0,100),like=`%${search.replace(/[\\%_]/g,'\\$&')}%`;
  const where=search?"WHERE o.name LIKE ? ESCAPE '\\' OR o.phone LIKE ? ESCAPE '\\' OR o.id LIKE ? ESCAPE '\\'":'';
  const args=search?[like,like,like]:[];
  const total=Number(db.prepare(`SELECT COUNT(*) AS n FROM organizations o ${where}`).get(...args).n||0);
  const rows=db.prepare(`SELECT o.id,o.name,o.organization_type,o.phone,o.address,o.created_at,
    (SELECT COUNT(*) FROM users u WHERE u.organization_id=o.id) AS users_count,
    (SELECT COUNT(*) FROM workers w WHERE w.organization_id=o.id) AS workers_count,
    (SELECT COUNT(*) FROM sites s WHERE s.organization_id=o.id) AS sites_count,
    (SELECT status FROM subscriptions sub WHERE sub.organization_id=o.id ORDER BY sub.created_at DESC LIMIT 1) AS subscription_status,
    (SELECT p.name FROM subscriptions sub JOIN plans p ON p.id=sub.plan_id WHERE sub.organization_id=o.id ORDER BY sub.created_at DESC LIMIT 1) AS plan_name
    FROM organizations o ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
  const items=rows.map(row=>({...row,phone:req.admin.role==='viewer'&&row.phone?`${row.phone.slice(0,3)}••••${row.phone.slice(-2)}`:row.phone}));
  res.set('Cache-Control','no-store').json({items,total,limit,offset});
});
app.get('/api/admin/plans',requireAdmin,adminPermission('plans_read'),(_req,res)=>{
  const plans=db.prepare(`SELECT p.*, (SELECT amount_minor FROM plan_prices pp WHERE pp.plan_id=p.id AND pp.billing_cycle='monthly' ORDER BY effective_from DESC LIMIT 1) AS monthly_price_minor,
    (SELECT amount_minor FROM plan_prices pp WHERE pp.plan_id=p.id AND pp.billing_cycle='yearly' ORDER BY effective_from DESC LIMIT 1) AS yearly_price_minor,
    (SELECT currency FROM plan_prices pp WHERE pp.plan_id=p.id ORDER BY effective_from DESC LIMIT 1) AS currency
    FROM plans p ORDER BY p.sort_order,p.name`).all();
  res.set('Cache-Control','no-store').json({plans});
});
const readAdminPlan=id=>{
  const plan=db.prepare('SELECT * FROM plans WHERE id=?').get(id);if(!plan)return null;
  return {...plan,prices:db.prepare('SELECT * FROM plan_prices WHERE plan_id=? ORDER BY effective_from DESC,billing_cycle').all(id),limits:Object.fromEntries(db.prepare('SELECT limit_key,value,unlimited FROM plan_limits WHERE plan_id=?').all(id).map(row=>[row.limit_key,{value:row.value,unlimited:Boolean(row.unlimited)}])),features:Object.fromEntries(db.prepare('SELECT feature_key,enabled FROM plan_features WHERE plan_id=?').all(id).map(row=>[row.feature_key,Boolean(row.enabled)])),overage:db.prepare('SELECT policy,warning_80,warning_100 FROM plan_overage_settings WHERE plan_id=?').get(id)||{policy:'soft_warn',warning_80:80,warning_100:100}};
};
function normalizePlanSettings(input){
  if(input.limits!==undefined){
    if(!input.limits||typeof input.limits!=='object'||Array.isArray(input.limits))return {error:'Plan limits must be an object.'};
    for(const [key,raw] of Object.entries(input.limits)){
      if(!PLAN_LIMIT_KEYS.has(key))return {error:`Unknown plan limit: ${key}.`};
      const limit=raw&&typeof raw==='object'?raw:{value:raw,unlimited:false};
      if(limit.unlimited!==true&&(!Number.isSafeInteger(limit.value)||limit.value<0))return {error:`${key} must be a nonnegative whole number or unlimited.`};
    }
  }
  if(input.features!==undefined){
    if(!input.features||typeof input.features!=='object'||Array.isArray(input.features))return {error:'Plan features must be an object.'};
    for(const [key,value] of Object.entries(input.features))if(!FEATURE_KEYS.includes(key)||typeof value!=='boolean')return {error:`Unknown or invalid plan feature: ${key}.`};
  }
  if(input.overage!==undefined){
    const overage=input.overage;
    if(!overage||typeof overage!=='object'||Array.isArray(overage)||!['block','charge_overage','soft_warn'].includes(overage.policy)||!Number.isInteger(overage.warning_80)||overage.warning_80<1||overage.warning_80>100||!Number.isInteger(overage.warning_100)||overage.warning_100<overage.warning_80||overage.warning_100>200)return {error:'Overage policy or warning thresholds are invalid.'};
  }
  return {};
}
function savePlanSettings(planId,input,stamp){
  for(const [key,raw] of Object.entries(input.limits||{})){
    const limit=raw&&typeof raw==='object'?raw:{value:raw,unlimited:false};
    db.prepare('INSERT INTO plan_limits(plan_id,limit_key,value,unlimited,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(plan_id,limit_key) DO UPDATE SET value=excluded.value,unlimited=excluded.unlimited,updated_at=excluded.updated_at').run(planId,key,limit.unlimited?null:limit.value,limit.unlimited?1:0,stamp);
  }
  for(const [key,enabled] of Object.entries(input.features||{}))db.prepare('INSERT INTO plan_features(plan_id,feature_key,enabled,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_id,feature_key) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at').run(planId,key,enabled?1:0,stamp);
  if(input.overage)db.prepare('INSERT INTO plan_overage_settings(plan_id,policy,warning_80,warning_100,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(plan_id) DO UPDATE SET policy=excluded.policy,warning_80=excluded.warning_80,warning_100=excluded.warning_100,updated_at=excluded.updated_at').run(planId,input.overage.policy,input.overage.warning_80,input.overage.warning_100,stamp);
}
app.get('/api/admin/plans/:id',requireAdmin,adminPermission('plans_read'),(req,res)=>{
  const plan=readAdminPlan(req.params.id);if(!plan)return sendError(res,404,'Plan not found.');
  res.set('Cache-Control','no-store').json({plan});
});
app.post('/api/admin/plans',adminCsrfAndOrigin,requireAdmin,adminPermission('plans_write'),(req,res)=>{
  const input=req.body||{},name=String(input.name||'').trim(),slug=String(input.slug||name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).toLowerCase(),currency=String(input.currency||'BDT').toUpperCase(),status=input.status||'draft';
  if(!name||name.length>80||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length>80)return sendError(res,422,'Enter a plan name and valid unique slug.');
  if(!['draft','active','hidden','archived'].includes(status)||!Number.isInteger(input.trial_days??0)||(input.trial_days??0)<0||(input.trial_days??0)>365)return sendError(res,422,'Plan status or trial length is invalid.');
  if(!/^[A-Z]{3}$/.test(currency)||!Number.isSafeInteger(input.monthly_price_minor)||input.monthly_price_minor<0||!Number.isSafeInteger(input.yearly_price_minor)||input.yearly_price_minor<0)return sendError(res,422,'Set monthly and yearly prices as integer minor units and select a 3-letter currency.');
  const settings=normalizePlanSettings(input);if(settings.error)return sendError(res,422,settings.error);
  const id=token(18),stamp=now();
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO plans(id,name,slug,description,status,sort_order,trial_days,badge_text,sample_values,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,?)').run(id,name,slug,String(input.description||'').slice(0,2000),status,Number.isInteger(input.sort_order)?input.sort_order:100,input.trial_days||0,String(input.badge_text||'').slice(0,80),stamp,stamp);
    for(const [cycle,amount] of [['monthly',input.monthly_price_minor],['yearly',input.yearly_price_minor]])db.prepare('INSERT INTO plan_prices(id,plan_id,billing_cycle,amount_minor,currency,effective_from,version,created_by,created_at) VALUES(?,?,?,?,?,?,1,?,?)').run(token(18),id,cycle,amount,currency,stamp,req.admin.id,stamp);
    savePlanSettings(id,input,stamp);
    writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'plan.created',targetType:'plan',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',after:{name,slug,status,currency,monthly_price_minor:input.monthly_price_minor,yearly_price_minor:input.yearly_price_minor},reason:String(input.reason||''),now:stamp});
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');if(String(error.message).includes('UNIQUE'))return sendError(res,409,'A plan with this slug already exists.');throw error;}
  res.status(201).json({plan:readAdminPlan(id)});
});
app.patch('/api/admin/plans/:id',adminCsrfAndOrigin,requireAdmin,adminPermission('plans_write'),(req,res)=>{
  const existing=readAdminPlan(req.params.id);if(!existing)return sendError(res,404,'Plan not found.');
  const input=req.body||{},settings=normalizePlanSettings(input);if(settings.error)return sendError(res,422,settings.error);
  const stamp=now(),name=input.name===undefined?existing.name:String(input.name).trim(),status=input.status===undefined?existing.status:input.status;
  if(!name||name.length>80||!['draft','active','hidden','archived'].includes(status))return sendError(res,422,'Plan name or status is invalid.');
  const priceUpdates=[];
  if(input.monthly_price_minor!==undefined||input.yearly_price_minor!==undefined||input.currency!==undefined){
    const currentCurrency=existing.prices[0]?.currency||'BDT',currency=String(input.currency||currentCurrency).toUpperCase();
    if(!/^[A-Z]{3}$/.test(currency))return sendError(res,422,'Currency must be a 3-letter code.');
    for(const [cycle,key] of [['monthly','monthly_price_minor'],['yearly','yearly_price_minor']]){
      if(input[key]===undefined&&currency===currentCurrency)continue;
      const current=existing.prices.find(price=>price.billing_cycle===cycle),amount=input[key]===undefined?Number(current?.amount_minor||0):input[key];
      if(!Number.isSafeInteger(amount)||amount<0)return sendError(res,422,`${cycle} price must be a nonnegative integer in minor units.`);
      if(!current||amount!==current.amount_minor||currency!==current.currency)priceUpdates.push({cycle,amount,currency});
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('UPDATE plans SET name=?,description=?,status=?,sort_order=?,trial_days=?,badge_text=?,updated_at=? WHERE id=?').run(name,String(input.description??existing.description).slice(0,2000),status,Number.isInteger(input.sort_order)?input.sort_order:existing.sort_order,Number.isInteger(input.trial_days)?Math.max(0,Math.min(365,input.trial_days)):existing.trial_days,String(input.badge_text??existing.badge_text).slice(0,80),stamp,existing.id);
    for(const price of priceUpdates){
      const version=Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM plan_prices WHERE plan_id=? AND billing_cycle=?').get(existing.id,price.cycle).n);
      db.prepare('INSERT INTO plan_prices(id,plan_id,billing_cycle,amount_minor,currency,effective_from,version,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(token(18),existing.id,price.cycle,price.amount,price.currency,stamp,version,req.admin.id,stamp);
      if(input.apply_existing===true)db.prepare("UPDATE subscriptions SET price_minor=?,currency=?,updated_at=? WHERE plan_id=? AND status IN ('active','trialing','past_due') AND billing_cycle=?").run(price.amount,price.currency,stamp,existing.id,price.cycle);
    }
    savePlanSettings(existing.id,input,stamp);
    const after=readAdminPlan(existing.id);
    writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'plan.updated',targetType:'plan',targetId:existing.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:existing,after,reason:String(input.reason||''),now:stamp});
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  res.json({plan:readAdminPlan(existing.id)});
});
const METERED_EVENT_TYPES=new Set(['sms_outbound','sms_inbound','voice_call','voice_seconds','ai_call','weather_api_call','geocode_call','email_sent']);
const METERED_UNITS=new Set(['segment','message','second','input_1m_tokens','output_1m_tokens','call','email','token']);
app.get('/api/admin/usage',requireAdmin,adminPermission('usage_read'),(req,res)=>{
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50)),offset=Math.max(0,Number.parseInt(req.query.offset,10)||0),filters=[],args=[];
  if(req.query.organization_id){filters.push('u.organization_id=?');args.push(String(req.query.organization_id).slice(0,120));}
  if(req.query.event_type){filters.push('u.event_type=?');args.push(String(req.query.event_type).slice(0,80));}
  if(req.query.from){const from=Number(req.query.from);if(Number.isSafeInteger(from)){filters.push('u.created_at>=?');args.push(from);}}
  if(req.query.to){const to=Number(req.query.to);if(Number.isSafeInteger(to)){filters.push('u.created_at<?');args.push(to);}}
  const where=filters.length?`WHERE ${filters.join(' AND ')}`:'';
  const total=Number(db.prepare(`SELECT COUNT(*) AS n FROM usage_events u ${where}`).get(...args).n||0);
  const items=db.prepare(`SELECT u.id,u.organization_id,o.name AS organization_name,u.site_id,u.event_type,u.provider,u.feature,u.quantity,u.unit,u.status,u.category,u.tokens_input,u.tokens_output,u.tokens_total,u.latency_ms,u.estimated,u.unit_cost_minor,u.unit_price_minor,u.cost_minor,u.price_minor,u.currency,u.model,u.created_at
    FROM usage_events u JOIN organizations o ON o.id=u.organization_id ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
  const periodNow=now(),organizations=db.prepare(`SELECT o.id,o.name,s.plan_id,s.current_period_start,s.current_period_end,p.name AS plan_name,(SELECT COUNT(*) FROM workers w WHERE w.organization_id=o.id) AS workers,(SELECT COUNT(*) FROM sites si WHERE si.organization_id=o.id) AS sites FROM organizations o LEFT JOIN subscriptions s ON s.id=(SELECT s2.id FROM subscriptions s2 WHERE s2.organization_id=o.id ORDER BY s2.created_at DESC LIMIT 1) LEFT JOIN plans p ON p.id=s.plan_id ORDER BY o.name`).all();
  const organizationUsage=organizations.map(org=>{const from=org.current_period_start||Math.floor(Date.UTC(new Date(periodNow*1000).getUTCFullYear(),new Date(periodNow*1000).getUTCMonth(),1)/1000),to=org.current_period_end?Math.min(periodNow,org.current_period_end):periodNow,usage=Object.fromEntries(db.prepare('SELECT event_type,SUM(quantity) AS quantity,SUM(cost_minor) AS cost_minor FROM usage_events WHERE organization_id=? AND created_at>=? AND created_at<? GROUP BY event_type').all(org.id,from,to).map(row=>[row.event_type,{quantity:Number(row.quantity||0),cost_minor:Number(row.cost_minor||0)}])),limits=org.plan_id?Object.fromEntries(db.prepare('SELECT limit_key,value,unlimited FROM plan_limits WHERE plan_id=?').all(org.plan_id).map(row=>[row.limit_key,row.unlimited?null:Number(row.value)])):{};return {id:org.id,name:org.name,plan_name:org.plan_name||'Basic',workers:Number(org.workers),sites:Number(org.sites),usage,limits};});
  res.set('Cache-Control','no-store').json({items,total,limit,offset,organization_usage:organizationUsage});
});
app.get('/api/admin/rates',requireAdmin,adminPermission('billing_read'),(_req,res)=>{
  res.set('Cache-Control','no-store').json({costs:db.prepare('SELECT * FROM cost_rates ORDER BY effective_from DESC LIMIT 500').all(),prices:db.prepare('SELECT * FROM price_rates ORDER BY effective_from DESC LIMIT 500').all()});
});
const ADMIN_BILLING_SETTINGS=new Set(['currency','tax_rate_bps','prices_include_tax','invoice_prefix','invoice_next_sequence','grace_period_days','safety_alerts_exempt_from_limits','default_plan_id','payment_instructions']);
app.get('/api/admin/settings/billing',requireAdmin,adminPermission('settings_write'),(_req,res)=>{
  const settings=Object.fromEntries(db.prepare('SELECT setting_key,value_json FROM billing_settings').all().filter(row=>ADMIN_BILLING_SETTINGS.has(row.setting_key)).map(row=>{try{return [row.setting_key,JSON.parse(row.value_json)];}catch{return [row.setting_key,null];}}));res.set('Cache-Control','no-store').json({settings});
});
app.put('/api/admin/settings/billing',adminCsrfAndOrigin,requireAdmin,adminPermission('settings_write'),(req,res)=>{
  const input=req.body?.settings,reason=String(req.body?.reason||'').trim().slice(0,500);if(!input||typeof input!=='object'||Array.isArray(input)||!reason)return sendError(res,422,'Provide billing settings and an audit reason.');
  const allowed=Object.fromEntries(Object.entries(input).filter(([key])=>ADMIN_BILLING_SETTINGS.has(key)));if(Object.keys(allowed).length!==Object.keys(input).length)return sendError(res,422,'Unknown billing setting.');
  if(allowed.currency!==undefined&&!/^[A-Z]{3}$/.test(String(allowed.currency).toUpperCase()))return sendError(res,422,'Currency must be a three-letter code.');
  if(allowed.tax_rate_bps!==undefined&&(!Number.isInteger(allowed.tax_rate_bps)||allowed.tax_rate_bps<0||allowed.tax_rate_bps>10000))return sendError(res,422,'Tax rate must be between 0 and 10000 basis points.');
  if(allowed.prices_include_tax!==undefined&&typeof allowed.prices_include_tax!=='boolean'||allowed.safety_alerts_exempt_from_limits!==undefined&&typeof allowed.safety_alerts_exempt_from_limits!=='boolean')return sendError(res,422,'Boolean billing settings must be true or false.');
  if(allowed.invoice_prefix!==undefined&&(typeof allowed.invoice_prefix!=='string'||allowed.invoice_prefix.length>24||!/^[A-Za-z0-9-]*$/.test(allowed.invoice_prefix)))return sendError(res,422,'Invoice prefix must contain up to 24 letters, digits or hyphens.');
  if(allowed.invoice_next_sequence!==undefined&&(!Number.isSafeInteger(Number(allowed.invoice_next_sequence))||Number(allowed.invoice_next_sequence)<1))return sendError(res,422,'Invoice sequence must be a positive whole number.');
  if(allowed.grace_period_days!==undefined&&(!Number.isInteger(allowed.grace_period_days)||allowed.grace_period_days<0||allowed.grace_period_days>90))return sendError(res,422,'Grace period must be between 0 and 90 days.');
  if(allowed.default_plan_id!==undefined&&!db.prepare('SELECT id FROM plans WHERE id=?').get(String(allowed.default_plan_id)))return sendError(res,422,'Default plan does not exist.');
  if(allowed.payment_instructions!==undefined&&(typeof allowed.payment_instructions!=='string'||allowed.payment_instructions.length>3000))return sendError(res,422,'Payment instructions must be 3000 characters or fewer.');
  const stamp=now(),before={};for(const [key,value] of Object.entries(allowed))before[key]=billingSetting(key,null);
  db.exec('BEGIN IMMEDIATE');try{for(const [key,value] of Object.entries(allowed))db.prepare('INSERT INTO billing_settings(setting_key,value_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(key,JSON.stringify(key==='currency'?String(value).toUpperCase():value),req.admin.id,stamp);writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'billing.settings_updated',targetType:'billing_settings',targetId:'global',ip:req.ip||'',userAgent:req.get('user-agent')||'',before,after:allowed,reason,now:stamp});db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  res.json({settings:Object.fromEntries(Object.entries(allowed).map(([key,value])=>[key,key==='currency'?String(value).toUpperCase():value]))});
});
app.get('/api/pricing',(_req,res)=>{
  const plans=db.prepare("SELECT * FROM plans WHERE status='active' AND sample_values=0 ORDER BY sort_order,name").all();
  const items=plans.map(plan=>({...plan,prices:db.prepare('SELECT billing_cycle,amount_minor,currency FROM plan_prices WHERE plan_id=? ORDER BY billing_cycle,effective_from DESC').all(plan.id).filter((row,index,rows)=>rows.findIndex(other=>other.billing_cycle===row.billing_cycle)===index),limits:Object.fromEntries(db.prepare('SELECT limit_key,value,unlimited FROM plan_limits WHERE plan_id=?').all(plan.id).map(row=>[row.limit_key,{value:row.value,unlimited:Boolean(row.unlimited)}])),features:Object.fromEntries(db.prepare('SELECT feature_key,enabled FROM plan_features WHERE plan_id=?').all(plan.id).map(row=>[row.feature_key,Boolean(row.enabled)]))}));
  res.set('Cache-Control','no-store').json({plans:items});
});
function billingSetting(key,fallback){try{return JSON.parse(db.prepare('SELECT value_json FROM billing_settings WHERE setting_key=?').get(key)?.value_json??JSON.stringify(fallback));}catch{return fallback;}}
function createPlanInvoice({organizationId,subscriptionId,planName,amountMinor,currency,stamp}){
  const next=Number(billingSetting('invoice_next_sequence',1)),prefix=String(billingSetting('invoice_prefix','JG-'));
  if(!Number.isSafeInteger(next)||next<1||!Number.isSafeInteger(amountMinor)||amountMinor<0)throw new Error('Invoice numbering or amount settings are invalid.');
  const taxRate=Number(billingSetting('tax_rate_bps',0)),inclusive=billingSetting('prices_include_tax',false);if(!Number.isInteger(taxRate)||taxRate<0||taxRate>10000)throw new Error('Tax settings are invalid.');
  const denominator=BigInt(inclusive?10000+taxRate:10000),numerator=BigInt(amountMinor)*BigInt(taxRate),tax=Number((numerator+denominator/2n)/denominator),total=inclusive?amountMinor:amountMinor+tax;if(!Number.isSafeInteger(total))throw new Error('Invoice amount exceeds the supported range.');
  const id=token(18),number=`${prefix}${String(next).padStart(6,'0')}`;
  db.prepare("UPDATE billing_settings SET value_json=?,updated_at=? WHERE setting_key='invoice_next_sequence'").run(JSON.stringify(String(next+1)),stamp);
  db.prepare("INSERT INTO invoices(id,organization_id,subscription_id,invoice_number,status,currency,subtotal_minor,tax_minor,total_minor,issued_at,due_at,billing_details_json,created_at) VALUES(?,?,?,?,'open',?,?,?,?,?,?,?,?)").run(id,organizationId,subscriptionId,number,currency,amountMinor,tax,total,stamp,stamp+7*86400,JSON.stringify(db.prepare('SELECT legal_name,address,tax_id FROM organization_billing_details WHERE organization_id=?').get(organizationId)||{}),stamp);
  db.prepare('INSERT INTO invoice_lines(id,invoice_id,description,line_type,quantity,unit_amount_minor,amount_minor,metadata_json) VALUES(?,?,?,?,?,?,?,?)').run(token(16),id,`${planName} subscription`, 'plan_fee',1,amountMinor,amountMinor,JSON.stringify({subscription_id:subscriptionId}));
  return id;
}
function runBillingLifecycle(stamp=now()){
  const outcome=processBillingLifecycle(db,{now:stamp,gracePeriodDays:Number(billingSetting('grace_period_days',7)),idFactory:()=>token(16),createInvoice:input=>createPlanInvoice(input)});
  for(const item of outcome.results)if(item.error)console.error(`Billing lifecycle failed for subscription ${item.subscription_id} (${item.error})`);
  return outcome;
}
app.get('/api/billing',requireUser,(req,res)=>{
  const org=req.user.organization_id,subscription=db.prepare("SELECT s.*,p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.organization_id=? ORDER BY s.created_at DESC LIMIT 1").get(org);
  const invoices=db.prepare('SELECT id,invoice_number,status,currency,subtotal_minor,tax_minor,total_minor,amount_paid_minor,issued_at,due_at,paid_at FROM invoices WHERE organization_id=? ORDER BY issued_at DESC LIMIT 100').all(org);
  const payments=db.prepare('SELECT id,invoice_id,adapter,status,amount_minor,currency,transaction_ref,created_at,verified_at FROM payments WHERE organization_id=? ORDER BY created_at DESC LIMIT 100').all(org);
  const details=db.prepare('SELECT legal_name,address,tax_id FROM organization_billing_details WHERE organization_id=?').get(org)||{legal_name:'',address:'',tax_id:''};
  const instructions=JSON.parse(db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='payment_instructions'").get()?.value_json||'"Manual payment instructions are not configured."');
  const resources={workers:Number(db.prepare('SELECT COUNT(*) AS n FROM workers WHERE organization_id=?').get(org).n),sites:Number(db.prepare('SELECT COUNT(*) AS n FROM sites WHERE organization_id=?').get(org).n)};
  const stamp=now(),monthStart=Math.floor(Date.UTC(new Date(stamp*1000).getUTCFullYear(),new Date(stamp*1000).getUTCMonth(),1)/1000),monthEnd=Math.floor(Date.UTC(new Date(stamp*1000).getUTCFullYear(),new Date(stamp*1000).getUTCMonth()+1,1)/1000);
  const usageStart=subscription?.current_period_start??monthStart,usageEnd=subscription?Math.min(stamp,subscription.current_period_end):stamp;
  const usage=db.prepare('SELECT event_type,SUM(quantity) AS quantity,SUM(cost_minor) AS cost_minor,SUM(price_minor) AS price_minor FROM usage_events WHERE organization_id=? AND created_at>=? AND created_at<? GROUP BY event_type').all(org,usageStart,usageEnd);
  const entitlements=getOrganizationEntitlements(db,org,subscription&&['trialing','active','past_due','suspended'].includes(subscription.status)?subscription:null);
  let defaultPlan=null;
  if(!subscription){const plan=db.prepare("SELECT * FROM plans WHERE id='sample-basic'").get();if(plan){const price=db.prepare("SELECT amount_minor,currency FROM plan_prices WHERE plan_id=? AND billing_cycle='monthly' ORDER BY effective_from DESC LIMIT 1").get(plan.id);defaultPlan={name:plan.name,price_minor:Number(price?.amount_minor??99900),currency:price?.currency||'BDT',period_start:monthStart,period_end:monthEnd};for(const row of db.prepare('SELECT limit_key,value,unlimited FROM plan_limits WHERE plan_id=?').all(plan.id))entitlements.limits[row.limit_key]=row.unlimited?{unlimited:true,value:null}:{unlimited:false,value:row.value};}}
  res.set('Cache-Control','no-store').json({subscription:subscription||null,default_plan:defaultPlan,invoices,payments,billing_details:details,payment_instructions:instructions,resources,limits:entitlements.limits,features:entitlements.features,usage});
});
app.put('/api/billing/details',csrfAndOrigin,requireUser,(req,res)=>{
  const details={legal_name:String(req.body.legal_name||'').trim().slice(0,160),address:String(req.body.address||'').trim().slice(0,500),tax_id:String(req.body.tax_id||'').trim().slice(0,80)};
  db.prepare('INSERT INTO organization_billing_details(organization_id,legal_name,address,tax_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET legal_name=excluded.legal_name,address=excluded.address,tax_id=excluded.tax_id,updated_at=excluded.updated_at').run(req.user.organization_id,details.legal_name,details.address,details.tax_id,now());
  res.json({billing_details:details});
});
app.get('/api/billing/invoices/:id',requireUser,(req,res)=>{
  const invoice=db.prepare('SELECT * FROM invoices WHERE id=? AND organization_id=?').get(req.params.id,req.user.organization_id);if(!invoice)return sendError(res,404,'Invoice not found.');
  res.set('Cache-Control','no-store').json({invoice,lines:db.prepare('SELECT description,line_type,quantity,unit_amount_minor,amount_minor FROM invoice_lines WHERE invoice_id=?').all(invoice.id)});
});
app.post('/api/billing/subscription/cancel',csrfAndOrigin,requireUser,(req,res)=>{
  const org=req.user.organization_id,sub=db.prepare("SELECT * FROM subscriptions WHERE organization_id=? AND status IN ('trialing','active','past_due') ORDER BY created_at DESC LIMIT 1").get(org);if(!sub)return sendError(res,404,'No cancellable subscription was found.');
  if(sub.cancel_at_period_end)return res.json({subscription:sub,message:'Cancellation is already scheduled.'});
  const stamp=now(),reason=String(req.body.reason||'Customer requested cancellation.').trim().slice(0,500);db.prepare('UPDATE subscriptions SET cancel_at_period_end=1,updated_at=? WHERE id=?').run(stamp,sub.id);db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),sub.id,org,'cancellation_scheduled',sub.status,sub.status,reason,stamp);
  res.json({subscription:db.prepare('SELECT * FROM subscriptions WHERE id=?').get(sub.id)});
});
app.post('/api/billing/subscription/reactivate',csrfAndOrigin,requireUser,(req,res)=>{
  const org=req.user.organization_id,sub=db.prepare("SELECT * FROM subscriptions WHERE organization_id=? AND status IN ('trialing','active','past_due') AND cancel_at_period_end=1 ORDER BY created_at DESC LIMIT 1").get(org);if(!sub)return sendError(res,404,'No scheduled cancellation was found.');
  const stamp=now();db.prepare('UPDATE subscriptions SET cancel_at_period_end=0,updated_at=? WHERE id=?').run(stamp,sub.id);db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),sub.id,org,'cancellation_reversed',sub.status,sub.status,'Customer reactivated subscription.',stamp);res.json({subscription:db.prepare('SELECT * FROM subscriptions WHERE id=?').get(sub.id)});
});
app.post('/api/billing/payments',csrfAndOrigin,requireUser,(req,res)=>{
  const org=req.user.organization_id,invoiceId=String(req.body.invoice_id||''),transactionRef=String(req.body.transaction_ref||'').trim(),proofRef=String(req.body.proof_ref||'').trim();
  if(!transactionRef||transactionRef.length>160||proofRef.length>500)return sendError(res,422,'Enter a transaction reference and an optional short proof reference.');
  const invoice=db.prepare("SELECT * FROM invoices WHERE id=? AND organization_id=? AND status='open'").get(invoiceId,org);
  if(!invoice)return sendError(res,404,'Open invoice not found.');
  const already=db.prepare("SELECT id FROM payments WHERE invoice_id=? AND status='pending'").get(invoiceId);if(already)return sendError(res,409,'A payment for this invoice is already awaiting review.');
  const id=token(18),stamp=now();try{db.prepare("INSERT INTO payments(id,invoice_id,organization_id,adapter,status,amount_minor,currency,transaction_ref,proof_ref,created_at) VALUES(?,?,?,'manual','pending',?,?,?,?,?)").run(id,invoice.id,org,invoice.total_minor-invoice.amount_paid_minor,invoice.currency,transactionRef,proofRef,stamp);}catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return sendError(res,409,'That transaction reference has already been submitted.');throw error;}
  res.status(201).json({payment:{id,status:'pending',amount_minor:invoice.total_minor-invoice.amount_paid_minor,currency:invoice.currency}});
});
app.get('/api/admin/invoices',requireAdmin,adminPermission('billing_read'),(req,res)=>{
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50)),offset=Math.max(0,Number.parseInt(req.query.offset,10)||0);
  const items=db.prepare('SELECT i.*,o.name AS organization_name FROM invoices i JOIN organizations o ON o.id=i.organization_id ORDER BY i.issued_at DESC LIMIT ? OFFSET ?').all(limit,offset);
  res.json({items,total:Number(db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n||0),limit,offset});
});
app.get('/api/admin/subscriptions',requireAdmin,adminPermission('billing_read'),(req,res)=>{
  const status=String(req.query.status||'');if(status&&!['trialing','active','past_due','suspended','cancelled','expired'].includes(status))return sendError(res,422,'Unknown subscription status.');
  const where=status?'WHERE s.status=?':'';const items=db.prepare(`SELECT s.*,o.name AS organization_name,p.name AS plan_name FROM subscriptions s JOIN organizations o ON o.id=s.organization_id JOIN plans p ON p.id=s.plan_id ${where} ORDER BY s.created_at DESC LIMIT 200`).all(...(status?[status]:[]));res.json({items});
});
app.post('/api/admin/subscriptions',adminCsrfAndOrigin,requireAdmin,adminPermission('billing_write'),(req,res)=>{
  const org=String(req.body.organization_id||''),planId=String(req.body.plan_id||''),cycle=req.body.billing_cycle,status=req.body.status||'active',reason=String(req.body.reason||'').trim().slice(0,500);
  const plan=readAdminPlan(planId);if(!db.prepare('SELECT id FROM organizations WHERE id=?').get(org)||!plan)return sendError(res,404,'Organization or plan not found.');
  if(!['monthly','yearly'].includes(cycle)||!['trialing','active','past_due'].includes(status)||!reason)return sendError(res,422,'Choose a valid billing cycle and initial status, with an audit reason.');
  const price=req.body.price_minor===undefined?plan.prices.find(item=>item.billing_cycle===cycle):{amount_minor:req.body.price_minor,currency:req.body.currency||plan.prices[0]?.currency||'BDT'};
  if(!price||!Number.isSafeInteger(price.amount_minor)||price.amount_minor<0||!/^[A-Z]{3}$/.test(String(price.currency).toUpperCase()))return sendError(res,422,'The selected plan has no valid price for that billing cycle.');
  const stamp=now(),id=token(18),duration=cycle==='yearly'?31536000:2592000,periodEnd=stamp+duration;
  db.exec('BEGIN IMMEDIATE');try{
    const previous=db.prepare("SELECT * FROM subscriptions WHERE organization_id=? AND status IN ('trialing','active','past_due','suspended') ORDER BY created_at DESC LIMIT 1").get(org);
    if(previous){db.prepare("UPDATE subscriptions SET status='cancelled',cancel_at_period_end=0,updated_at=? WHERE id=?").run(stamp,previous.id);db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),previous.id,org,'replaced',previous.status,'cancelled',reason,stamp);}
    db.prepare('INSERT INTO subscriptions(id,organization_id,plan_id,status,billing_cycle,price_minor,currency,current_period_start,current_period_end,trial_end,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,org,planId,status,cycle,price.amount_minor,String(price.currency).toUpperCase(),stamp,periodEnd,status==='trialing'?periodEnd:null,stamp,stamp);
    db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,to_status,details_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),id,org,'assigned',status,JSON.stringify({plan_id:planId,billing_cycle:cycle,price_minor:price.amount_minor}),reason,stamp);
    writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'subscription.assigned',targetType:'subscription',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',after:{organization_id:org,plan_id:planId,status,billing_cycle:cycle,price_minor:price.amount_minor,currency:price.currency},reason,now:stamp});db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  res.status(201).json({subscription:db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id)});
});
app.patch('/api/admin/subscriptions/:id/status',adminCsrfAndOrigin,requireAdmin,adminPermission('billing_write'),(req,res)=>{
  const current=db.prepare('SELECT * FROM subscriptions WHERE id=?').get(req.params.id);if(!current)return sendError(res,404,'Subscription not found.');
  const target=String(req.body.status||''),reason=String(req.body.reason||'').trim().slice(0,500);if(!reason)return sendError(res,422,'Include a reason for the subscription status change.');
  if(!canTransitionSubscription(current.status,target))return sendError(res,409,`Subscription cannot transition from ${current.status} to ${target}.`);
  const stamp=now();db.exec('BEGIN IMMEDIATE');try{
    db.prepare('UPDATE subscriptions SET status=?,updated_at=?,grace_end=? WHERE id=?').run(target,stamp,target==='past_due'?stamp+Number(billingSetting('grace_period_days',7))*86400:null,current.id);
    db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),current.id,current.organization_id,'status_changed',current.status,target,reason,stamp);
    writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'subscription.status_changed',targetType:'subscription',targetId:current.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:{status:current.status},after:{status:target},reason,now:stamp});db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  res.json({subscription:db.prepare('SELECT * FROM subscriptions WHERE id=?').get(current.id)});
});
app.post('/api/admin/invoices',adminCsrfAndOrigin,requireAdmin,adminPermission('billing_write'),(req,res)=>{
  const org=String(req.body.organization_id||''),subscriptionId=req.body.subscription_id?String(req.body.subscription_id):null,lines=req.body.lines;
  if(!db.prepare('SELECT id FROM organizations WHERE id=?').get(org))return sendError(res,404,'Organization not found.');
  if(subscriptionId&&!db.prepare('SELECT id FROM subscriptions WHERE id=? AND organization_id=?').get(subscriptionId,org))return sendError(res,422,'Subscription does not belong to this organization.');
  if(!Array.isArray(lines)||!lines.length||lines.length>50)return sendError(res,422,'Add between 1 and 50 invoice lines.');
  const normalized=[];for(const line of lines){const description=String(line.description||'').trim(),quantity=line.quantity,unit=line.unit_amount_minor;if(!description||description.length>240||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000||!Number.isSafeInteger(unit)||unit<0||unit>100000000000)return sendError(res,422,'Invoice lines need a description, positive whole quantity, and nonnegative integer unit amount.');normalized.push({description,quantity,unit,amount:quantity*unit});}
  const subtotal=normalized.reduce((sum,line)=>sum+line.amount,0);if(!Number.isSafeInteger(subtotal))return sendError(res,422,'Invoice total exceeds the supported amount.');
  const taxBps=Number(JSON.parse(db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='tax_rate_bps'").get()?.value_json||'0'));if(!Number.isInteger(taxBps)||taxBps<0||taxBps>10000)return sendError(res,503,'Billing tax configuration is invalid.');
  const currency=String(req.body.currency||db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='currency'").get()?.value_json||'"BDT"').replaceAll('"','').toUpperCase();if(!/^[A-Z]{3}$/.test(currency))return sendError(res,422,'Use a valid three-letter currency code.');
  const inclusive=JSON.parse(db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='prices_include_tax'").get()?.value_json||'false'),taxDenominator=BigInt(inclusive?10000+taxBps:10000),taxNumerator=BigInt(subtotal)*BigInt(taxBps),tax=Number((taxNumerator+taxDenominator/2n)/taxDenominator),total=inclusive?subtotal:subtotal+tax;if(!Number.isSafeInteger(total))return sendError(res,422,'Invoice total exceeds the supported amount.');
  const stamp=now(),id=token(18),seqRow=db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='invoice_next_sequence'").get(),sequence=Number(JSON.parse(seqRow?.value_json||'1')),prefix=String(JSON.parse(db.prepare("SELECT value_json FROM billing_settings WHERE setting_key='invoice_prefix'").get()?.value_json||'"JG-"'));
  if(!Number.isSafeInteger(sequence)||sequence<1)return sendError(res,503,'Invoice sequence configuration is invalid.');
  const number=`${prefix}${String(sequence).padStart(6,'0')}`;
  db.exec('BEGIN IMMEDIATE');try{
    db.prepare("UPDATE billing_settings SET value_json=?,updated_by=?,updated_at=? WHERE setting_key='invoice_next_sequence'").run(JSON.stringify(String(sequence+1)),req.admin.id,stamp);
    db.prepare("INSERT INTO invoices(id,organization_id,subscription_id,invoice_number,status,currency,subtotal_minor,tax_minor,total_minor,issued_at,due_at,billing_details_json,created_at) VALUES(?,?,?,?,'open',?,?,?,?,?,?,?,?)").run(id,org,subscriptionId,number,currency,subtotal,tax,total,stamp,Number.isSafeInteger(req.body.due_at)?req.body.due_at:null,JSON.stringify(db.prepare('SELECT legal_name,address,tax_id FROM organization_billing_details WHERE organization_id=?').get(org)||{}),stamp);
    const insert=db.prepare('INSERT INTO invoice_lines(id,invoice_id,description,line_type,quantity,unit_amount_minor,amount_minor,metadata_json) VALUES(?,?,?,?,?,?,?,?)');for(const line of normalized)insert.run(token(16),id,line.description,'manual',line.quantity,line.unit,line.amount,'{}');
    writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'invoice.created',targetType:'invoice',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',after:{invoice_number:number,organization_id:org,total_minor:total,currency},reason:String(req.body.reason||''),now:stamp});db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  res.status(201).json({invoice:db.prepare('SELECT * FROM invoices WHERE id=?').get(id),lines:db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(id)});
});
app.get('/api/admin/payments',requireAdmin,adminPermission('billing_read'),(req,res)=>res.json({items:db.prepare('SELECT p.*,o.name AS organization_name,i.invoice_number FROM payments p JOIN organizations o ON o.id=p.organization_id JOIN invoices i ON i.id=p.invoice_id ORDER BY p.created_at DESC LIMIT 200').all()}));
app.post('/api/admin/payments/:id/review',adminCsrfAndOrigin,requireAdmin,adminPermission('billing_write'),(req,res)=>{
  const payment=db.prepare("SELECT p.*,i.status AS invoice_status,i.total_minor,i.amount_paid_minor,i.subscription_id FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.id=? AND p.adapter='manual'").get(req.params.id);if(!payment)return sendError(res,404,'Manual payment not found.');if(payment.status!=='pending')return sendError(res,409,'Payment has already been reviewed.');
  const action=req.body.action,reason=String(req.body.reason||'').trim().slice(0,500);if(!['approve','reject'].includes(action)||!reason)return sendError(res,422,'Choose approve or reject and include a review reason.');
  const stamp=now();db.exec('BEGIN IMMEDIATE');try{
    const status=action==='approve'?'succeeded':'rejected';db.prepare('UPDATE payments SET status=?,verified_by=?,verified_at=? WHERE id=? AND status=\'pending\'').run(status,req.admin.id,stamp,payment.id);
    if(action==='approve'){
      const paid=Math.min(payment.total_minor,payment.amount_paid_minor+payment.amount_minor),complete=paid>=payment.total_minor;
      db.prepare('UPDATE invoices SET amount_paid_minor=?,status=?,paid_at=? WHERE id=?').run(paid,complete?'paid':'open',complete?stamp:null,payment.invoice_id);
      if(complete&&payment.subscription_id){const sub=db.prepare('SELECT * FROM subscriptions WHERE id=?').get(payment.subscription_id);if(sub){const periodEnd=stamp+(sub.billing_cycle==='yearly'?31536000:2592000);db.prepare("UPDATE subscriptions SET status='active',current_period_start=?,current_period_end=?,grace_end=NULL,updated_at=? WHERE id=?").run(stamp,periodEnd,stamp,sub.id);db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),sub.id,sub.organization_id,'payment_verified',sub.status,'active',reason,stamp);}}
    }
    writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:action==='approve'?'payment.approved':'payment.rejected',targetType:'payment',targetId:payment.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:{status:'pending'},after:{status:action==='approve'?'succeeded':'rejected'},reason,now:stamp});db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  res.json({payment:db.prepare('SELECT * FROM payments WHERE id=?').get(payment.id)});
});
app.get('/api/admin/analytics',requireAdmin,adminPermission('billing_read'),(req,res)=>{
  const end=Number.isSafeInteger(Number(req.query.to))?Number(req.query.to):now(),from=Number.isSafeInteger(Number(req.query.from))?Number(req.query.from):Math.floor(new Date(new Date(end*1000).getFullYear(),new Date(end*1000).getMonth(),1).getTime()/1000);if(from>=end)return sendError(res,422,'Analytics start must be earlier than the end.');
  const invoices=db.prepare("SELECT COALESCE(SUM(total_minor),0) AS invoiced,COALESCE(SUM(CASE WHEN status='open' THEN total_minor-amount_paid_minor ELSE 0 END),0) AS outstanding FROM invoices WHERE issued_at>=? AND issued_at<?").get(from,end);
  const collected=Number(db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM payments WHERE status='succeeded' AND verified_at>=? AND verified_at<?").get(from,end).n||0),refunds=Number(db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS n FROM refunds WHERE created_at>=? AND created_at<?').get(from,end).n||0);
  const usageCost=Number(db.prepare('SELECT COALESCE(SUM(cost_minor),0) AS n FROM usage_events WHERE created_at>=? AND created_at<?').get(from,end).n||0),expenseCost=Number(db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS n FROM expenses WHERE expense_date>=date(?,'unixepoch') AND expense_date<=date(?,'unixepoch')").get(from,end-1).n||0);
  const planRevenueRows=db.prepare("SELECT s.billing_cycle,COALESCE((SELECT pp.amount_minor FROM plan_prices pp WHERE pp.plan_id=s.plan_id AND pp.billing_cycle=s.billing_cycle ORDER BY pp.effective_from DESC,pp.version DESC LIMIT 1),s.price_minor) AS current_price_minor FROM subscriptions s WHERE s.status IN ('active','trialing')").all(),mrr=planRevenueRows.reduce((sum,row)=>sum+(row.billing_cycle==='yearly'?Math.round(row.current_price_minor/12):row.current_price_minor),0);
  const byPlan=db.prepare("SELECT p.id,p.name,(SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id=p.id) AS subscriptions,(SELECT COALESCE(SUM(CASE WHEN s.billing_cycle='yearly' THEN COALESCE((SELECT pp.amount_minor FROM plan_prices pp WHERE pp.plan_id=s.plan_id AND pp.billing_cycle=s.billing_cycle ORDER BY pp.effective_from DESC,pp.version DESC LIMIT 1),s.price_minor)/12 ELSE COALESCE((SELECT pp.amount_minor FROM plan_prices pp WHERE pp.plan_id=s.plan_id AND pp.billing_cycle=s.billing_cycle ORDER BY pp.effective_from DESC,pp.version DESC LIMIT 1),s.price_minor) END),0) FROM subscriptions s WHERE s.plan_id=p.id AND s.status IN ('active','trialing')) AS mrr_minor,(SELECT COALESCE(SUM(u.cost_minor),0) FROM usage_events u JOIN subscriptions s ON s.organization_id=u.organization_id AND s.plan_id=p.id AND s.id=(SELECT s2.id FROM subscriptions s2 WHERE s2.organization_id=u.organization_id ORDER BY s2.created_at DESC LIMIT 1) WHERE u.created_at>=? AND u.created_at<?) AS usage_cost_minor FROM plans p ORDER BY mrr_minor DESC").all(from,end);
  const counts=Object.fromEntries(['active','trialing','past_due','suspended'].map(status=>[status,Number(db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE status=?').get(status).n||0)]));
  res.set('Cache-Control','no-store').json({period:{from,to:end},mrr_minor:mrr,revenue_minor:mrr,current_plan_revenue_minor:mrr,invoiced_minor:Number(invoices.invoiced||0),collected_minor:collected,refunds_minor:refunds,outstanding_minor:Number(invoices.outstanding||0),provider_cost_minor:usageCost,expenses_minor:expenseCost,profit_minor:mrr-refunds-usageCost-expenseCost,counts,by_plan:byPlan});
});
app.get('/api/admin/expenses',requireAdmin,adminPermission('billing_read'),(_req,res)=>res.json({items:db.prepare('SELECT * FROM expenses ORDER BY expense_date DESC,created_at DESC LIMIT 500').all(),totals:db.prepare('SELECT currency,SUM(amount_minor) AS amount_minor,COUNT(*) AS count FROM expenses GROUP BY currency ORDER BY currency').all()}));
app.post('/api/admin/expenses',adminCsrfAndOrigin,requireAdmin,adminPermission('expenses_write'),(req,res)=>{
  const input=req.body||{},category=String(input.category||''),description=String(input.description||'').trim(),date=String(input.expense_date||''),amount=input.amount_minor,currency=String(input.currency||'BDT').toUpperCase();
  if(!['hosting','domain','gateway_fees','salaries','marketing','other'].includes(category)||!description||description.length>240||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(amount)||amount<0||!/^[A-Z]{3}$/.test(currency))return sendError(res,422,'Enter a valid expense category, description, date, integer amount in minor units, and currency.');
  const id=token(18),stamp=now();db.prepare('INSERT INTO expenses(id,category,description,amount_minor,currency,expense_date,recurring,notes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,category,description,amount,currency,date,input.recurring===true?1:0,String(input.notes||'').slice(0,2000),req.admin.id,stamp,stamp);
  writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'expense.created',targetType:'expense',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',after:{category,description,amount_minor:amount,currency,expense_date:date},reason:String(input.reason||''),now:stamp});res.status(201).json({expense:db.prepare('SELECT * FROM expenses WHERE id=?').get(id)});
});
app.patch('/api/admin/expenses/:id',adminCsrfAndOrigin,requireAdmin,adminPermission('expenses_write'),(req,res)=>{
  const current=db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);if(!current)return sendError(res,404,'Expense not found.');const input=req.body||{},category=String(input.category??current.category),description=String(input.description??current.description).trim(),date=String(input.expense_date??current.expense_date),amount=input.amount_minor??current.amount_minor,currency=String(input.currency??current.currency).toUpperCase(),reason=String(input.reason||'').trim().slice(0,500);
  if(!['hosting','domain','gateway_fees','salaries','marketing','other'].includes(category)||!description||description.length>240||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(amount)||amount<0||!/^[A-Z]{3}$/.test(currency)||!reason)return sendError(res,422,'Expense fields are invalid or an audit reason is missing.');
  db.prepare('UPDATE expenses SET category=?,description=?,amount_minor=?,currency=?,expense_date=?,recurring=?,notes=?,updated_at=? WHERE id=?').run(category,description,amount,currency,date,input.recurring===undefined?current.recurring:input.recurring?1:0,String(input.notes??current.notes).slice(0,2000),now(),current.id);writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'expense.updated',targetType:'expense',targetId:current.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:current,after:db.prepare('SELECT * FROM expenses WHERE id=?').get(current.id),reason,now:now()});res.json({expense:db.prepare('SELECT * FROM expenses WHERE id=?').get(current.id)});
});
app.delete('/api/admin/expenses/:id',adminCsrfAndOrigin,requireAdmin,adminPermission('expenses_write'),(req,res)=>{
  const current=db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);if(!current)return sendError(res,404,'Expense not found.');const reason=String(req.body?.reason||'').trim().slice(0,500);if(!reason)return sendError(res,422,'Include a reason to remove this expense.');db.prepare('DELETE FROM expenses WHERE id=?').run(current.id);writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'expense.deleted',targetType:'expense',targetId:current.id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:current,reason,now:now()});res.json({ok:true});
});
app.post('/api/admin/rates/costs',adminCsrfAndOrigin,requireAdmin,adminPermission('billing_write'),(req,res)=>{
  const input=req.body||{},eventType=String(input.event_type||''),provider=String(input.provider||'').trim().toLowerCase(),model=String(input.model||'').trim(),unit=String(input.unit||''),currency=String(input.currency||'BDT').toUpperCase(),amount=input.unit_cost_minor;
  if(!METERED_EVENT_TYPES.has(eventType)||!provider||provider.length>80||model.length>100||!METERED_UNITS.has(unit)||!Number.isSafeInteger(amount)||amount<0||!/^[A-Z]{3}$/.test(currency))return sendError(res,422,'Enter a valid event, provider, unit, integer cost in minor units, and currency.');
  const effective=Number(input.effective_from),effectiveFrom=Number.isSafeInteger(effective)?effective:now(),previous=db.prepare('SELECT unit_cost_minor,currency,effective_from FROM cost_rates WHERE event_type=? AND provider=? AND model=? AND unit=? ORDER BY effective_from DESC LIMIT 1').get(eventType,provider,model,unit),id=token(18),stamp=now();
  db.prepare('INSERT INTO cost_rates(id,event_type,provider,model,unit,unit_cost_minor,currency,effective_from,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,eventType,provider,model,unit,amount,currency,effectiveFrom,req.admin.id,stamp);
  writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'cost_rate.created',targetType:'cost_rate',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:previous||null,after:{event_type:eventType,provider,model,unit,unit_cost_minor:amount,currency,effective_from:effectiveFrom},reason:String(input.reason||''),now:stamp});
  res.status(201).json({id,effective_from:effectiveFrom});
});
app.post('/api/admin/rates/prices',adminCsrfAndOrigin,requireAdmin,adminPermission('billing_write'),(req,res)=>{
  const input=req.body||{},eventType=String(input.event_type||''),feature=String(input.feature||''),unit=String(input.unit||''),currency=String(input.currency||'BDT').toUpperCase(),amount=input.unit_price_minor;
  if(!METERED_EVENT_TYPES.has(eventType)||feature.length>80||!METERED_UNITS.has(unit)||!Number.isSafeInteger(amount)||amount<0||!/^[A-Z]{3}$/.test(currency))return sendError(res,422,'Enter a valid event, feature, unit, integer price in minor units, and currency.');
  const effective=Number(input.effective_from),effectiveFrom=Number.isSafeInteger(effective)?effective:now(),previous=db.prepare('SELECT unit_price_minor,currency,effective_from FROM price_rates WHERE event_type=? AND feature=? AND unit=? ORDER BY effective_from DESC LIMIT 1').get(eventType,feature,unit),id=token(18),stamp=now();
  db.prepare('INSERT INTO price_rates(id,event_type,feature,unit,unit_price_minor,currency,effective_from,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,eventType,feature,unit,amount,currency,effectiveFrom,req.admin.id,stamp);
  writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'price_rate.created',targetType:'price_rate',targetId:id,ip:req.ip||'',userAgent:req.get('user-agent')||'',before:previous||null,after:{event_type:eventType,feature,unit,unit_price_minor:amount,currency,effective_from:effectiveFrom},reason:String(input.reason||''),now:stamp});
  res.status(201).json({id,effective_from:effectiveFrom});
});
app.get('/api/admin/audit',requireAdmin,adminPermission('audit_read'),(req,res)=>{
  const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit,10)||50)),offset=Math.max(0,Number.parseInt(req.query.offset,10)||0);
  const rows=db.prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit,offset);
  res.set('Cache-Control','no-store').json({items:rows,total:Number(db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').get().n||0),limit,offset});
});
app.get('/api/admin/auth/sessions',requireAdmin,(req,res)=>{
  const sessions=db.prepare('SELECT token_hash,created_at,expires_at,ip,user_agent,reauth_at FROM admin_sessions WHERE admin_id=? AND expires_at>=? ORDER BY created_at DESC').all(req.admin.id,now()).map((session,index)=>({...session,current:index===0}));
  res.set('Cache-Control','no-store').json({sessions});
});
app.delete('/api/admin/auth/sessions/:hash',adminCsrfAndOrigin,requireAdmin,(req,res)=>{
  const key=String(req.params.hash||'');
  const target=db.prepare('SELECT admin_id FROM admin_sessions WHERE token_hash=?').get(key);
  if(!target||target.admin_id!==req.admin.id)return sendError(res,404,'Admin session not found.');
  db.prepare('DELETE FROM admin_sessions WHERE token_hash=? AND admin_id=?').run(key,req.admin.id);
  writeAdminAudit(db,{adminId:req.admin.id,role:req.admin.role,action:'admin.session_revoked',targetType:'admin_session',targetId:key.slice(0,12),ip:req.ip||'',userAgent:req.get('user-agent')||'',now:now()});
  res.json({ok:true});
});

app.get('/api/auth/csrf', (req, res) => {
  const csrf = csrfToken(req);
  if (csrf.set) res.cookie(CSRF_COOKIE, csrf.value, cookieOptions(false, REMEMBER_LIFETIME));
  res.set('Cache-Control', 'no-store').json({ csrf_token: csrf.value });
});
app.get('/api/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, service: 'jibonguard-api' }));
const FEATURE_MASTERS = Object.freeze({ nowcast: process.env.NOWCAST_ENABLED === 'true', breakPlanner: process.env.SMART_BREAK_SCHEDULER_ENABLED === 'true', triage: process.env.TRIAGE_ENABLED === 'true', aiTriage: process.env.AI_TRIAGE_ENABLED === 'true', reports: process.env.AI_SAFETY_REPORTS_ENABLED === 'true' });
const featureDefaults = Object.freeze({ nowcast: false, breakPlanner: false, triage: false, aiTriage: false, reports: false });
function orgFeatures(organizationId) {
  let saved = {};
  try { saved = JSON.parse(db.prepare('SELECT settings_json FROM org_ai_features WHERE organization_id=?').get(organizationId)?.settings_json || '{}'); } catch { /* fail closed to defaults */ }
  return Object.fromEntries(Object.entries(featureDefaults).map(([key, fallback]) => [key, FEATURE_MASTERS[key] && saved[key] === true || FEATURE_MASTERS[key] && saved[key] === undefined && fallback]));
}
app.get('/api/features', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json({ features: orgFeatures(req.user.organization_id), masters: FEATURE_MASTERS }));
app.put('/api/features', csrfAndOrigin, requireUser, (req, res) => {
  const input = req.body?.features;
  const allowed = Object.keys(featureDefaults);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || Object.values(input).some(value => typeof value !== 'boolean')) return sendError(res, 400, 'Choose valid organization feature settings.');
  if (!rateAllowed(req, 'feature-settings', 10, 3600)) return sendError(res, 429, 'Settings are being changed too quickly.');
  const previous = orgFeatures(req.user.organization_id);
  const requested = Object.fromEntries(allowed.map(key => [key, Object.hasOwn(input, key) ? input[key] : previous[key]]));
  const effective = Object.fromEntries(allowed.map(key => [key, FEATURE_MASTERS[key] && requested[key]]));
  db.prepare('INSERT INTO org_ai_features(organization_id,settings_json,updated_at) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at').run(req.user.organization_id, JSON.stringify(requested), now());
  res.json({ features: effective, masters: FEATURE_MASTERS });
});
app.get('/api/auth/me', requireUser, (req, res) => res.set('Cache-Control', 'no-store').json({ authenticated: true, user: req.user }));
app.get('/api/workers', requireUser, (req, res) => {
  const workers = db.prepare(`SELECT w.*,COALESCE((SELECT action FROM worker_consent_events e WHERE e.worker_id=w.id ORDER BY e.changed_at DESC,e.rowid DESC LIMIT 1),'pending') AS consent_status FROM workers w WHERE organization_id=? ORDER BY name COLLATE NOCASE`).all(req.user.organization_id);
  res.json({ workers });
});
app.get('/api/sites', requireUser, (req, res) => res.json({ sites: db.prepare('SELECT id,name,address,latitude,longitude,division,district,emergency_contact_phone,shade_available,water_available,rest_area,created_at,updated_at FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE').all(req.user.organization_id) }));
app.get('/api/breaks', requireUser, (req, res) => {
  const date = String(req.query.date || '');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendError(res, 400, 'Enter a valid date.');
  const records = db.prepare(`SELECT b.id,b.title,b.site,b.break_date,b.break_time,b.duration_minutes,b.worker_count,b.status,b.source,b.alert_type,b.ai_rationale,b.workload_levels,b.created_at,
    (SELECT CASE WHEN SUM(CASE WHEN q.status='scheduled' THEN 1 ELSE 0 END)>0 THEN 'queued' WHEN SUM(CASE WHEN q.status='sending' THEN 1 ELSE 0 END)>0 THEN 'sending' WHEN SUM(CASE WHEN q.status='failed' THEN 1 ELSE 0 END)>0 THEN 'failed' WHEN SUM(CASE WHEN q.status='sent' THEN 1 ELSE 0 END)>0 THEN 'sent' ELSE 'none' END FROM scheduled_break_sms q WHERE q.break_id=b.id) AS sms_status
    FROM break_logs b WHERE b.organization_id=? ORDER BY b.break_date DESC,b.break_time DESC,b.created_at DESC`).all(req.user.organization_id);
  res.json({ breaks: records, total: records.length, date_total: date ? records.filter(row => row.break_date === date && row.status === 'logged').length : 0 });
});
const defaultAlertSettings=()=>({enabled:false,aiEnabled:false,baseHeatTriggerC:ALERT_CONFIG.baseHeatTriggerC,workloadOffsets:{...ALERT_CONFIG.workloadOffsets},rainLeadMinutes:ALERT_CONFIG.rainLeadMinutes,rainProbability:ALERT_CONFIG.rainProbability,cooldownMinutes:ALERT_CONFIG.cooldownMinutes,dailyCap:ALERT_CONFIG.dailyCap,quietHours:{...ALERT_CONFIG.quietHours}});
function alertSettingsFor(org){const row=db.prepare('SELECT settings_json,enabled,ai_enabled FROM alert_settings WHERE organization_id=?').get(org);let saved={};try{saved=JSON.parse(row?.settings_json||'{}');}catch{}const workloadOffsets=Object.fromEntries(Object.keys(ALERT_CONFIG.workloadOffsets).map(level=>[level,saved.workloadOffsets?.[level]??ALERT_CONFIG.workloadOffsets[level]]));return {...defaultAlertSettings(),...saved,enabled:Boolean(row?.enabled),aiEnabled:Boolean(row?.ai_enabled)&&ALERT_CONFIG.aiEnabled,workloadOffsets,quietHours:{...ALERT_CONFIG.quietHours,...(saved.quietHours||{})}};}
function sanitizeAlertSettings(input,base=defaultAlertSettings()){
  const n=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback;
  const offsets={};for(const level of ['Light','Standard','Moderate','Heavy'])offsets[level]=n(input.workloadOffsets?.[level],base.workloadOffsets[level],0,10);
  const clock=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value||''))?String(value):null;
  return {enabled:input.enabled===true,aiEnabled:input.aiEnabled===true,baseHeatTriggerC:n(input.baseHeatTriggerC,base.baseHeatTriggerC,28,42),workloadOffsets:offsets,rainLeadMinutes:n(input.rainLeadMinutes,base.rainLeadMinutes,15,360),rainProbability:n(input.rainProbability,base.rainProbability,1,100),cooldownMinutes:n(input.cooldownMinutes,base.cooldownMinutes,1,1440),dailyCap:n(input.dailyCap,base.dailyCap,1,100),quietHours:{start:clock(input.quietHours?.start)||base.quietHours.start,end:clock(input.quietHours?.end)||base.quietHours.end}};
}
function runtimeAlertConfig(settings){return {...ALERT_CONFIG,...settings,enabled:ALERT_CONFIG.enabled&&settings.enabled,aiEnabled:ALERT_CONFIG.aiEnabled&&settings.aiEnabled,apiKey:GEMINI_API_KEY,model:ALERT_CONFIG.model,db,meterUsage:event=>metering.recordUsage(event),organizationId:null};}
app.get('/api/alerts/settings',requireUser,(req,res)=>res.set('Cache-Control','no-store').json({settings:alertSettingsFor(req.user.organization_id),aiAvailable:Boolean(ALERT_CONFIG.aiEnabled&&GEMINI_API_KEY),automationAvailable:ALERT_CONFIG.enabled}));
app.put('/api/alerts/settings',csrfAndOrigin,requireUser,(req,res)=>{
  const current=alertSettingsFor(req.user.organization_id),settings=sanitizeAlertSettings(req.body,current),org=req.user.organization_id;
  db.prepare('INSERT INTO alert_settings(organization_id,settings_json,enabled,ai_enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET settings_json=excluded.settings_json,enabled=excluded.enabled,ai_enabled=excluded.ai_enabled,updated_at=excluded.updated_at').run(org,JSON.stringify(settings),settings.enabled?1:0,settings.aiEnabled?1:0,now());
  res.json({settings:alertSettingsFor(org)});
});
app.get('/api/alerts/automated',requireUser,(req,res)=>{
  const today=new Date();today.setHours(0,0,0,0);const cutoff=Math.floor(today.getTime()/1000),items=db.prepare('SELECT a.id,a.site_id,s.name AS site,w.name AS worker_name,a.alert_type,a.channel,a.action,a.status,a.scheduled_at,a.created_at,a.sent_at,a.reason,a.floor FROM automated_alerts a LEFT JOIN sites s ON s.id=a.site_id LEFT JOIN workers w ON w.id=a.worker_id WHERE a.organization_id=? AND a.created_at>=? ORDER BY a.created_at DESC LIMIT 100').all(req.user.organization_id,cutoff);
  const counts=db.prepare("SELECT SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled FROM automated_alerts WHERE organization_id=? AND created_at>=?").get(req.user.organization_id,cutoff);
  const delayed=[...ALERT_WEATHER_STATUS.entries()].some(([key,value])=>key.startsWith(`${req.user.organization_id}:`)&&value.delayed);
  res.set('Cache-Control','no-store').json({items,counts:{sent:counts.sent||0,skipped:counts.skipped||0,scheduled:counts.scheduled||0},weatherDelayed:delayed});
});
app.get('/api/dashboard/summary',requireUser,(req,res)=>{
  const org=req.user.organization_id,counts=db.prepare(`SELECT
    (SELECT COUNT(*) FROM workers WHERE organization_id=?) AS workers,
    (SELECT COUNT(*) FROM workers WHERE organization_id=? AND consent_at IS NOT NULL) AS consented_workers,
    (SELECT COUNT(*) FROM sites WHERE organization_id=?) AS sites,
    (SELECT COUNT(*) FROM break_logs WHERE organization_id=?) AS breaks`).get(org,org,org,org);
  const workers=db.prepare('SELECT id,name,site,consent_at FROM workers WHERE organization_id=? ORDER BY name COLLATE NOCASE LIMIT 6').all(org);
  const breaks=db.prepare('SELECT id,title,site,break_date,break_time,source FROM break_logs WHERE organization_id=? ORDER BY break_date DESC,break_time DESC,created_at DESC LIMIT 5').all(org);
  const today=new Date();today.setHours(0,0,0,0);const cutoff=Math.floor(today.getTime()/1000);
  const alertCounts=db.prepare("SELECT SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled FROM automated_alerts WHERE organization_id=? AND created_at>=?").get(org,cutoff);
  const delayed=[...ALERT_WEATHER_STATUS.entries()].some(([key,value])=>key.startsWith(`${org}:`)&&value.delayed);
  const config=alertSettingsFor(org);
  res.set('Cache-Control','no-store').json({user:req.user,workers,breaks,counts:{workers:Number(counts.workers||0),consentedWorkers:Number(counts.consented_workers||0),sites:Number(counts.sites||0),breaks:Number(counts.breaks||0)},automationSettings:config,automationAvailable:ALERT_CONFIG.enabled,aiAvailable:Boolean(ALERT_CONFIG.aiEnabled&&GEMINI_API_KEY),automationInfo:{items:[],counts:{sent:alertCounts.sent||0,skipped:alertCounts.skipped||0,scheduled:alertCounts.scheduled||0},weatherDelayed:delayed}});
});
app.post('/api/alerts/simulate',csrfAndOrigin,requireUser,requirePlanFeature('simulator'),async(req,res)=>{
  const siteId=String(req.body.site_id||''),temperatureC=Number(req.body.temperature_c),rainEtaRaw=req.body.rain_eta_minutes,timeOfDay=String(req.body.time_of_day||'12:00');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)||!Number.isFinite(temperatureC)||temperatureC<0||temperatureC>60||!(rainEtaRaw===''||rainEtaRaw==null||(Number.isFinite(Number(rainEtaRaw))&&Number(rainEtaRaw)>=0&&Number(rainEtaRaw)<=360)))return sendError(res,400,'Choose a valid temperature, rain ETA, and time of day.');
  const site=db.prepare('SELECT * FROM sites WHERE id=? AND organization_id=?').get(siteId,req.user.organization_id);if(!site)return sendError(res,404,'Worksite not found.');if(site.latitude==null||site.longitude==null)return sendError(res,422,'Add coordinates to this worksite before simulating weather alerts.');
  const config=runtimeAlertConfig(alertSettingsFor(req.user.organization_id)),contexts=await buildAlertContexts(site,req.user.organization_id,config,{simulation:{temperatureC,rainEtaMinutes:rainEtaRaw===''?null:Number(rainEtaRaw),timeOfDay}});
  const aiClient=async(items,cfg)=>{if(!cfg.aiEnabled||!rateAllowed(req,'alert-simulation',4,3600))return {decisions:[],status:'disabled'};const {callAlertAi}=await import('./server/alerts/ai.js');return callAlertAi(items,cfg);};
  config.organizationId=req.user.organization_id;
  const result=await decideAlerts(contexts,{config,aiClient,getHistory:workerId=>{const count=db.prepare("SELECT COUNT(*) AS n FROM automated_alerts WHERE organization_id=? AND worker_id=? AND created_at>=? AND status IN ('sent','queued','scheduled')").get(req.user.organization_id,workerId,now()-86400).n;return {sentToday:count,lastByType:{}};}});
  const names=new Map(db.prepare('SELECT id,name FROM workers WHERE organization_id=? AND site_id=?').all(req.user.organization_id,siteId).map(worker=>[worker.id,worker.name]));
  res.json({aiStatus:result.aiStatus,weatherDelayed:contexts.some(item=>item.weather.weatherDelayed),decisions:result.decisions.map(item=>({workerId:item.workerId,workerName:names.get(item.workerId)||'Worker',action:item.final_status,alertType:item.alert_type,channel:item.channel,sendAt:item.send_at||null,reason:item.reason,message:item.message,floor:item.floor}))});
});
app.get('/api/sms', requireUser, async (req, res) => {
  const apiKey = (process.env.TEXTBEE_API_KEY || process.env.TEXTBEE_DEV_API || '').trim();
  const queuedMessages=()=>db.prepare(`SELECT 'break-queue-'||q.id AS id,'sent' AS direction,'' AS sender,q.recipient,q.message,
    CASE q.status WHEN 'scheduled' THEN 'queued' WHEN 'sending' THEN 'sending' ELSE q.status END AS status,
    '' AS device_name,datetime(q.scheduled_at,'unixepoch')||'Z' AS message_at
    FROM scheduled_break_sms q WHERE q.organization_id=? ORDER BY q.scheduled_at DESC LIMIT 250`).all(req.user.organization_id);
  const localMessages=()=>[...db.prepare('SELECT id,direction,sender,recipient,message,status,device_name,message_at FROM sms_messages WHERE organization_id=? ORDER BY message_at DESC LIMIT 250').all(req.user.organization_id),...queuedMessages()].sort((a,b)=>Date.parse(b.message_at)-Date.parse(a.message_at)).slice(0,250);
  if(req.query.sync==='0'){
    const messages=localMessages(),receivedMatched=messages.filter(item=>item.direction==='received').length;
    return res.set('Cache-Control','no-store').json({messages,configured:Boolean(apiKey),synced:0,receivedFromTextbee:receivedMatched,receivedMatched});
  }
  if (!apiKey) return res.set('Cache-Control','no-store').json({messages:queuedMessages(),configured:false,synced:0,message:'TextBee is not configured.'});
  const base = (process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1').replace(/\/$/,'');
  if (!base.startsWith('https://')) return sendError(res, 503, 'TextBee must use an HTTPS API URL.');
  try {
    const headers={'x-api-key':apiKey,Accept:'application/json','User-Agent':'JibonGuard/1.0 (SMS history sync)'};
    const [sentResponse,receivedResponse]=await Promise.all(['sent','received'].map(direction=>fetch(`${base}/gateway/messages?direction=${direction}&order=desc&limit=100`,{signal:AbortSignal.timeout(15000),headers})));
    const failedResponse=[sentResponse,receivedResponse].find(response=>!response.ok);
    if (failedResponse) return sendError(res, failedResponse.status===401?401:502, failedResponse.status===401?'TextBee rejected the API key. Check TEXTBEE_API_KEY.':`TextBee message history request failed (HTTP ${failedResponse.status}).`);
    const [sentResult,receivedResult]=await Promise.all([sentResponse.json(),receivedResponse.json()]);
    const workers = db.prepare('SELECT phone FROM workers WHERE organization_id=?').all(req.user.organization_id);
    const phoneKeys = value => {
      const ascii=String(value||'').replace(/[\u09e6-\u09ef]/g,digit=>String(digit.charCodeAt(0)-0x09e6));
      const digits=ascii.replace(/\D/g,'');
      return [normalizePhone(ascii),digits.length>=10?digits.slice(-10):null].filter(Boolean);
    };
    const numbers = new Set(workers.flatMap(row=>phoneKeys(row.phone)));
    const hiddenMessageIds=new Set(db.prepare('SELECT id FROM sms_deleted_messages WHERE organization_id=?').all(req.user.organization_id).map(row=>row.id));
    const sentMessages=(Array.isArray(sentResult.data)?sentResult.data:[]).map(item=>({...item,direction:'sent'}));
    const receivedMessages=(Array.isArray(receivedResult.data)?receivedResult.data:[]).map(item=>({...item,direction:'received'}));
    const incomingById=new Map();
    for (const item of [...sentMessages,...receivedMessages]) {
      const sender=String(item.sender||''), recipient=String(item.recipient||'');
      const direction=item.direction;
      const matched=phoneKeys(direction==='received'?sender:recipient).some(phone=>numbers.has(phone));
      if (!matched || !item._id || !['sent','received'].includes(direction) || hiddenMessageIds.has(String(item._id))) continue;
      const stamp = direction==='received'?(item.receivedAt||item.createdAt):(item.sentAt||item.requestedAt||item.createdAt);
      incomingById.set(String(item._id),{id:String(item._id),organization_id:req.user.organization_id,direction,sender,recipient,message:String(item.message||''),status:String(item.status||'unknown'),device_name:String(item.device?.name||''),message_at:stamp||new Date().toISOString(),created_at:now()});

    }
    const incoming=[...incomingById.values()],existingIds=new Set();
    for(let offset=0;offset<incoming.length;offset+=200){const batch=incoming.slice(offset,offset+200),marks=batch.map(()=>'?').join(',');for(const row of db.prepare(`SELECT id FROM sms_messages WHERE organization_id=? AND id IN (${marks})`).all(req.user.organization_id,...batch.map(row=>row.id)))existingIds.add(row.id);}
    const upsertBatch=batch=>{
      const tuple='('+Array(10).fill('?').join(',')+')';
      const sql=`INSERT INTO sms_messages(id,organization_id,direction,sender,recipient,message,status,device_name,message_at,created_at) VALUES ${batch.map(()=>tuple).join(',')} ON CONFLICT(organization_id,id) DO UPDATE SET status=excluded.status,message=excluded.message,message_at=excluded.message_at`;
      db.prepare(sql).run(...batch.flatMap(row=>[row.id,row.organization_id,row.direction,row.sender,row.recipient,row.message,row.status,row.device_name,row.message_at,row.created_at]));
    };
    for(let offset=0;offset<incoming.length;offset+=80)upsertBatch(incoming.slice(offset,offset+80));
    const newReceived=incoming.filter(row=>row.direction==='received'&&!existingIds.has(row.id));
    for(const row of newReceived){const emergency=Boolean(emergencySmsCode(row.message));metering.recordUsage({organizationId:req.user.organization_id,eventType:'sms_inbound',provider:'textbee',feature:emergency?'emergency_code':'inbound',quantity:1,unit:'message',status:row.status,category:emergency?'safety':'routine',metadata:{segments:calculateSmsSegments(row.message).segments},refType:'provider_message',refId:row.id,idempotencyKey:`sms-in:${req.user.organization_id}:${row.id}`});}
    const synced=incoming.length,receivedMatched=incoming.filter(row=>row.direction==='received').length;
    const messages=localMessages();
    res.set('Cache-Control','no-store').json({messages,configured:true,synced,receivedFromTextbee:receivedMessages.length,receivedMatched});
  } catch { return sendError(res,502,'Could not reach TextBee. Try syncing again shortly.'); }
});
app.get('/api/privacy/export', requireUser, (req, res) => {
  const organization = db.prepare('SELECT name,organization_type,phone,address,estimated_workers,created_at FROM organizations WHERE id=?').get(req.user.organization_id);
  const privacy = db.prepare('SELECT privacy_notice_version,privacy_consent_at,created_at FROM users WHERE id=?').get(req.user.id);
  const workers = db.prepare('SELECT id,name,phone,site,site_id,job_type,workload,risk_level,shift_start,shift_end,age_group,has_personal_risk_factor,outdoor_minutes,last_break,consent_at,consent_method,created_at,updated_at FROM workers WHERE organization_id=? ORDER BY name COLLATE NOCASE').all(req.user.organization_id);
  const sites = db.prepare('SELECT id,name,address,latitude,longitude,shade_available,water_available,rest_area,created_at,updated_at FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE').all(req.user.organization_id);
  const break_logs = db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,workload_levels,created_at FROM break_logs WHERE organization_id=? ORDER BY break_date DESC,break_time DESC').all(req.user.organization_id);
  const sms_messages = db.prepare('SELECT id,direction,sender,recipient,message,status,device_name,message_at FROM sms_messages WHERE organization_id=? ORDER BY message_at DESC').all(req.user.organization_id);
  const worker_consent_events = db.prepare('SELECT worker_id,action,method,note,changed_by,changed_at FROM worker_consent_events WHERE organization_id=? ORDER BY changed_at DESC,rowid DESC').all(req.user.organization_id);
  res.set('Content-Disposition', 'attachment; filename=jibonguard-account-data.json').json({ account: req.user, organization, workers, sites, worker_consent_events, break_logs, sms_messages, privacy, exported_at: new Date().toISOString() });
});

app.put('/api/account/organization', csrfAndOrigin, requireUser, (req, res) => {
  const name = typeof req.body.organization_name === 'string' ? req.body.organization_name.trim() : '';
  if (!name || name.length > 160) return sendError(res, 400, 'Enter a company name between 1 and 160 characters.');
  const result = db.prepare('UPDATE organizations SET name=? WHERE id=?').run(name, req.user.organization_id);
  if (!result.changes) return sendError(res, 404, 'Organization not found.');
  res.set('Cache-Control', 'no-store').json({ organization_name: name });
});

app.post('/api/account/change-password', csrfAndOrigin, requireUser, async (req, res) => {
  if (!rateAllowed(req, 'change-password', 5, 900)) return sendError(res, 429, 'Too many password-change attempts. Try again later.');
  const { current_password: currentPassword, new_password: newPassword, confirm_password: confirmPassword } = req.body;
  if (typeof currentPassword !== 'string' || currentPassword.length > 128 || typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN || newPassword.length > 128) {
    return sendError(res, 400, `Enter your current password and choose a new password between ${PASSWORD_MIN} and 128 characters.`);
  }
  if (newPassword !== confirmPassword) return sendError(res, 400, 'The new password and confirmation do not match.');
  const row = db.prepare('SELECT password_hash,password_salt FROM users WHERE id=?').get(req.user.id);
  if (!row || !(await checkPassword(currentPassword, row.password_hash, row.password_salt))) return sendError(res, 401, 'Current password did not match.');
  if (await checkPassword(newPassword, row.password_hash, row.password_salt)) return sendError(res, 400, 'Choose a new password that is different from your current password.');
  const { passwordHash, passwordSalt } = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').run(passwordHash, passwordSalt, req.user.id);
  const currentSessionHash = hashToken(parseCookies(req)[SESSION_COOKIE]);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id, currentSessionHash);
  db.prepare('DELETE FROM action_tokens WHERE user_id=?').run(req.user.id);
  db.prepare("DELETE FROM auth_otp_challenges WHERE user_id=? AND purpose='login'").run(req.user.id);
  res.set('Cache-Control', 'no-store').json({ message: 'Password changed. Other signed-in sessions have been signed out.' });
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
  const selectedSlug=String(d.plan_slug||'').trim(),billingCycle=String(d.billing_cycle||'monthly');
  if(selectedSlug==='legacy')return sendError(res,422,'Legacy uses custom enterprise pricing. Contact sales to set up this plan.');
  if(!['monthly','yearly'].includes(billingCycle))return sendError(res,422,'Choose a valid billing cycle.');
  let selectedPlan;
  if(selectedSlug){selectedPlan=db.prepare("SELECT * FROM plans WHERE slug=? AND status='active' AND sample_values=0").get(selectedSlug);if(!selectedPlan)return sendError(res,422,'That plan is not currently available.');}
  else{const defaultPlanId=String(billingSetting('default_plan_id','sample-basic'));selectedPlan=db.prepare('SELECT * FROM plans WHERE id=?').get(defaultPlanId)||db.prepare("SELECT * FROM plans WHERE id='sample-basic'").get();}
  const selectedPrice=db.prepare('SELECT amount_minor,currency FROM plan_prices WHERE plan_id=? AND billing_cycle=? ORDER BY effective_from DESC,version DESC LIMIT 1').get(selectedPlan.id,billingCycle);
  if(!selectedPrice)return sendError(res,422,'That plan does not have a price for the selected billing cycle.');
  const ids = token(18), organizationId = token(18), stamp = now(), { passwordHash, passwordSalt } = await hashPassword(password);
  let challenge;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO organizations(id,name,organization_type,phone,estimated_workers,created_at) VALUES(?,?,?,?,?,?)').run(organizationId, organization, type, phone, Number(workerCount), stamp);
    db.prepare(`INSERT INTO users(id,organization_id,full_name,email,phone,password_hash,password_salt,role,privacy_notice_version,privacy_consent_at,email_verified_at,created_at)
      VALUES(?,?,?,?,?,?,?,'organization_owner','2026-10-01',?,NULL,?)`).run(ids, organizationId, name, email, phone, passwordHash, passwordSalt, stamp, stamp);
    const trialing=selectedPlan.trial_days>0,subscriptionId=token(18),periodLength=billingCycle==='yearly'?31536000:2592000,periodEnd=trialing?stamp+selectedPlan.trial_days*86400:stamp+periodLength,subscriptionStatus=trialing?'trialing':selectedPrice.amount_minor===0?'active':'past_due';
    db.prepare('INSERT INTO subscriptions(id,organization_id,plan_id,status,billing_cycle,price_minor,currency,current_period_start,current_period_end,trial_end,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(subscriptionId,organizationId,selectedPlan.id,subscriptionStatus,billingCycle,selectedPrice.amount_minor,selectedPrice.currency,stamp,periodEnd,trialing?periodEnd:null,stamp,stamp);
    db.prepare('INSERT INTO subscription_events(id,subscription_id,organization_id,event_type,to_status,details_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(token(16),subscriptionId,organizationId,'signup_subscription',subscriptionStatus,JSON.stringify({plan_id:selectedPlan.id,billing_cycle:billingCycle}),selectedSlug?'Customer chose plan at signup.':'Default plan assigned at signup.',stamp);
    if(subscriptionStatus==='past_due')createPlanInvoice({organizationId,subscriptionId,planName:selectedPlan.name,amountMinor:selectedPrice.amount_minor,currency:selectedPrice.currency,stamp});
    challenge=issueAuthOtp(ids,'signup');
    db.exec('COMMIT');
  } catch (error) { try{db.exec('ROLLBACK');}catch{} if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'An account with these details already exists.'); throw error; }
  try { await emailAuthOtp({email,full_name:name},challenge,'signup'); }
  catch { try{db.exec('BEGIN IMMEDIATE');db.prepare('DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=?)').run(organizationId);db.prepare('DELETE FROM invoices WHERE organization_id=?').run(organizationId);db.prepare('DELETE FROM subscription_events WHERE organization_id=?').run(organizationId);db.prepare('DELETE FROM subscriptions WHERE organization_id=?').run(organizationId);db.prepare('DELETE FROM organizations WHERE id=?').run(organizationId);db.exec('COMMIT');}catch{try{db.exec('ROLLBACK');}catch{}}return sendError(res,502,'We could not deliver the verification code, so the account was not created. Check the SMTP settings and try again.'); }
  res.status(201).json({ otp_required:true,purpose:'signup',challenge_id:challenge.challengeId,email,resend_after:OTP_RESEND_COOLDOWN_SECONDS,message:'We emailed a 6-digit verification code. Enter it to finish creating your account.' });
});

app.post('/api/auth/login', csrfAndOrigin, async (req, res) => {
  if (!rateAllowed(req, 'login', 8)) return sendError(res, 429, 'Too many sign-in attempts. Please try again later.');
  const email = String(req.body.email || '').trim().toLowerCase(), password = req.body.password;
  if (email.length > 254 || typeof password !== 'string' || password.length > 128) return sendError(res, 400, 'Enter a valid email and password.');
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) { await hashPassword(password || 'invalid-password'); return sendError(res, 401, 'Email or password is incorrect.'); }
  if (!(await checkPassword(password, user.password_hash, user.password_salt))) return sendError(res, 401, 'Email or password is incorrect.');
  const nextPath=safeNext(req.body.next||'/dashboard.html');
  if(!user.email_verified_at){
    const challenge=issueAuthOtp(user.id,'signup',req.body.remember===true,nextPath);
    try { await emailAuthOtp(user,challenge,'signup'); }
    catch (error) { db.prepare('DELETE FROM auth_otp_challenges WHERE id=?').run(challenge.challengeId); console.error('Signup verification OTP delivery failed:', JSON.stringify({ code: error.code, command: error.command, responseCode: error.responseCode })); return sendError(res,502,'We could not send a verification code. Check the server SMTP log for the delivery reason, then try again.'); }
    return res.json({otp_required:true,purpose:'signup',challenge_id:challenge.challengeId,email:user.email,resend_after:OTP_RESEND_COOLDOWN_SECONDS,message:'This account still needs email verification. We sent a verification code.'});
  }
  db.prepare("DELETE FROM auth_otp_challenges WHERE user_id=? AND purpose='login'").run(user.id);
  const remember=req.body.remember===true,lifetime=remember?REMEMBER_LIFETIME:SESSION_LIFETIME,opaque=token(32),cookie=parseCookies(req)[SESSION_COOKIE],stamp=now();
  if(cookie)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookie));
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(hashToken(opaque),user.id,stamp,stamp+lifetime);
  const csrf=token(32);res.cookie(SESSION_COOKIE,opaque,cookieOptions(true,lifetime));res.cookie(CSRF_COOKIE,csrf,cookieOptions(false,REMEMBER_LIFETIME));
  res.json({message:'Signed in.',csrf_token:csrf,next:nextPath});
});
app.post('/api/auth/verify-otp', csrfAndOrigin, (req,res)=>{
  if(!rateAllowed(req,'verify-otp',10))return sendError(res,429,'Too many code attempts. Please try again later.');
  const id=String(req.body.challenge_id||''),code=String(req.body.code||'').trim();
  if(!/^[A-Za-z0-9_-]{24,64}$/.test(id)||!/^\d{6}$/.test(code))return sendError(res,400,'Enter the 6-digit code from your email.');
  const challenge=db.prepare('SELECT c.*,u.email_verified_at FROM auth_otp_challenges c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(id);
  if(!challenge||challenge.expires_at<now())return sendError(res,400,'That code expired. Request a new one and try again.');
  if(challenge.purpose==='login')return sendError(res,410,'Sign-in codes are disabled. Please sign in with your password.');
  if(challenge.attempts>=5)return sendError(res,429,'Too many incorrect codes. Request a new code.');
  if(hashToken(`${id}:${code}`)!==challenge.otp_hash){const attempts=challenge.attempts+1;db.prepare('UPDATE auth_otp_challenges SET attempts=? WHERE id=?').run(attempts,id);return sendError(res,attempts>=5?429:400,attempts>=5?'Too many incorrect codes. Request a new code.':'The code is incorrect. Check the email and try again.');}
  db.prepare('DELETE FROM auth_otp_challenges WHERE id=?').run(id);
  if(challenge.purpose==='signup') db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(now(),challenge.user_id);
  else if(!challenge.email_verified_at)return sendError(res,400,'Verify your email before signing in.');
  const remember=Boolean(challenge.remember),lifetime=remember?REMEMBER_LIFETIME:SESSION_LIFETIME,opaque=token(32),cookie=parseCookies(req)[SESSION_COOKIE];
  if(cookie)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookie));
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(hashToken(opaque),challenge.user_id,now(),now()+lifetime);
  const csrf=token(32);res.cookie(SESSION_COOKIE,opaque,cookieOptions(true,lifetime));res.cookie(CSRF_COOKIE,csrf,cookieOptions(false,REMEMBER_LIFETIME));
  res.json({message:challenge.purpose==='signup'?'Email verified. Your account is ready.':'Signed in.',csrf_token:csrf,next:safeNext(challenge.next_path)});
});
app.post('/api/auth/resend-otp',csrfAndOrigin,async(req,res)=>{
  if(!rateAllowed(req,'resend-otp',4))return sendError(res,429,'Too many code requests. Please try again later.');
  const id=String(req.body.challenge_id||''),email=String(req.body.email||'').trim().toLowerCase();
  const prior=db.prepare('SELECT c.*,u.email,u.full_name,u.email_verified_at FROM auth_otp_challenges c JOIN users u ON u.id=c.user_id WHERE c.id=? AND u.email=? COLLATE NOCASE AND c.created_at>=?').get(id,email,now()-86400);
  if(!prior)return sendError(res,400,'This code request can no longer be renewed. Start sign-in again.');
  if(prior.purpose==='login')return sendError(res,410,'Sign-in codes are disabled. Please sign in with your password.');
  if(prior.purpose==='signup'&&prior.email_verified_at)return sendError(res,400,'Email is already verified. Return to sign in.');
  const resendAfter=Math.max(0,OTP_RESEND_COOLDOWN_SECONDS-(now()-prior.created_at));
  if(resendAfter>0)return res.status(429).json({error:`Please wait ${resendAfter} seconds before requesting another code.`,resend_after:resendAfter});
  const challenge=issueAuthOtp(prior.user_id,prior.purpose,Boolean(prior.remember),prior.next_path);
  try{await emailAuthOtp(prior,challenge,prior.purpose);}catch{db.prepare('DELETE FROM auth_otp_challenges WHERE id=?').run(challenge.challengeId);return sendError(res,502,'We could not send a new code. Check the SMTP settings and try again.');}
  res.json({challenge_id:challenge.challengeId,resend_after:OTP_RESEND_COOLDOWN_SECONDS,message:'A new 6-digit code has been sent.'});
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
  const email = String(req.body.email || '').trim().toLowerCase(), result = { message: 'If that address has an account awaiting verification, a new code will be sent.' };
  if (email.length <= 254 && /^[^\s@]{1,64}@[^ @.]+(?:\.[^ @.]+)+$/.test(email)) {
    const user = db.prepare('SELECT id,full_name FROM users WHERE email=? AND email_verified_at IS NULL').get(email);
    if (user) {
      const previous=db.prepare("SELECT created_at FROM auth_otp_challenges WHERE user_id=? AND purpose='signup' ORDER BY created_at DESC LIMIT 1").get(user.id);
      const resendAfter=previous?Math.max(0,OTP_RESEND_COOLDOWN_SECONDS-(now()-previous.created_at)):0;
      if(resendAfter>0)return res.status(429).json({error:`Please wait ${resendAfter} seconds before requesting another code.`,resend_after:resendAfter});
      const challenge=issueAuthOtp(user.id,'signup');
      try{await emailAuthOtp({...user,email},challenge,'signup');}catch{db.prepare('DELETE FROM auth_otp_challenges WHERE id=?').run(challenge.challengeId);return sendError(res,502,'We could not send a new code. Check the SMTP settings and try again.');}
      Object.assign(result,{otp_required:true,purpose:'signup',challenge_id:challenge.challengeId,email,resend_after:OTP_RESEND_COOLDOWN_SECONDS,message:'We emailed a new 6-digit verification code.'});
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
  db.prepare('DELETE FROM action_tokens WHERE user_id=?').run(row.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);db.prepare('DELETE FROM auth_otp_challenges WHERE user_id=?').run(row.user_id);
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
  const started=Date.now(),organizationId=db.prepare('SELECT organization_id FROM users WHERE email=? COLLATE NOCASE').get(String(recipient||''))?.organization_id||null,requestId=token(16);
  const recordEmail=(status,free=false)=>{if(organizationId)metering.recordUsage({organizationId,eventType:'email_sent',provider:'smtp',feature:'account_email',quantity:1,unit:'email',status,unitCostMinor:free?0:undefined,unitPriceMinor:free?0:undefined,latencyMs:Date.now()-started,idempotencyKey:`email:${requestId}`});};
  const host = process.env.SMTP_HOST;
  if (!host) {
    if (IS_PRODUCTION) throw new Error('Email delivery is not configured.');
    console.log(`\n[development email] To: ${recipient}\nSubject: ${subject}\n${body}\n`);
    recordEmail('development_logged',true);
    return;
  }
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port number.');
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) throw new Error('SMTP_USER and SMTP_PASSWORD are required for SMTP delivery.');
  if (!from) throw new Error('Set SMTP_FROM to a verified sender address.');

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  try {
    const result = await transport.sendMail({ from, to: recipient, subject, text: body });
    const accepted = Array.isArray(result.accepted) ? result.accepted : [];
    const recipientAccepted = accepted.some(address => String(address).toLowerCase() === String(recipient).toLowerCase());
    if (!recipientAccepted) {
      const error = new Error('SMTP did not accept the message recipient.');
      error.code = 'EENVELOPE';
      error.command = 'RCPT TO';
      error.responseCode = result.responseCode;
      error.response = result.response;
      error.rejectedCount = Array.isArray(result.rejected) ? result.rejected.length : 0;
      throw error;
    }
    let relayResponse = String(result.response || '').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
    for (const secret of [process.env.SMTP_USER, process.env.SMTP_PASSWORD]) if (secret) relayResponse = relayResponse.split(secret).join('[redacted]');
    console.info('SMTP accepted message:', JSON.stringify({ messageId: result.messageId, response: relayResponse || 'accepted by relay' }));
    recordEmail('accepted');
  } catch (error) {
    recordEmail('failed');
    // Log provider diagnostics only; never include credentials, recipient, or message content.
    let response = String(error.response || '').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
    for (const secret of [process.env.SMTP_USER, process.env.SMTP_PASSWORD]) if (secret) response = response.split(secret).join('[redacted]');
    console.error('SMTP delivery failed:', JSON.stringify({ code: error.code, command: error.command, responseCode: error.responseCode, rejectedCount: error.rejectedCount, response }));
    throw error;
  } finally {
    transport.close();
  }
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
function normalizeShiftTime(value, fallback) {
  const raw=String(value||fallback).trim(),match=raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if(!match)return raw;
  let hour=Number(match[1]);const minute=Number(match[2]),meridiem=match[3]?.toUpperCase();
  if(minute>59)return raw;
  if(meridiem){if(hour<1||hour>12)return raw;hour=hour%12+(meridiem==='PM'?12:0);}else if(hour>23)return raw;
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}
function workerValues(data, organizationId) {
  const banglaDigits = '০১২৩৪৫৬৭৮৯', name = String(data.name || '').trim(), phone = String(data.phone || '').replace(/[০-৯]/g, digit => String(banglaDigits.indexOf(digit))).trim();
  const siteId = String(data.site_id || '').trim(), legacySite = String(data.site || '').trim();
  const jobType = String(data.job_type || '').trim(), workload = String(data.workload || 'Standard').trim();
  const shiftStart=normalizeShiftTime(data.shift_start,'07:00'),shiftEnd=normalizeShiftTime(data.shift_end,'17:00'),ageGroup=String(data.age_group||'').trim();
  if (!name || name.length > 120 || !/^[+()0-9 .-]{7,24}$/.test(phone) || !jobType || jobType.length > 120 || !['Light','Standard','Heavy'].includes(workload) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftEnd) || !['','under_18','18_40','over_40'].includes(ageGroup)) return null;
  const site = db.prepare('SELECT id,name FROM sites WHERE organization_id=? AND (id=? OR name=? COLLATE NOCASE)').get(organizationId, siteId, legacySite);
  if (!site) throw Object.assign(new Error('Choose a worksite from your saved Sites list. Create the site first if it is not listed.'), { status: 400 });
  return { name, phone, siteId: site.id, site: site.name, jobType, workload, shiftStart, shiftEnd, ageGroup, hasPersonalRiskFactor: data.has_personal_risk_factor === 'on' || data.has_personal_risk_factor === true || data.has_personal_risk_factor === 1 };
}
function siteValues(data) {
  const name = String(data.name || '').trim(), address = String(data.address || '').trim(), latitudeRaw = String(data.latitude ?? '').trim(), longitudeRaw = String(data.longitude ?? '').trim();
  const hasLatitude=latitudeRaw!=='',hasLongitude=longitudeRaw!=='',latitude=hasLatitude?Number(latitudeRaw):null,longitude=hasLongitude?Number(longitudeRaw):null;
  if (!name || name.length > 120 || address.length > 500 || hasLatitude!==hasLongitude || (hasLatitude&&(!Number.isFinite(latitude)||latitude < -90 || latitude > 90)) || (hasLongitude&&(!Number.isFinite(longitude)||longitude < -180 || longitude > 180))) return null;
  const division = String(data.division || '').trim().slice(0, 80), district = String(data.district || '').trim().slice(0, 80), emergencyPhoneRaw=String(data.emergency_contact_phone||'').trim(),emergencyContactPhone=emergencyPhoneRaw?normalizePhone(emergencyPhoneRaw):'';
  if (emergencyPhoneRaw && !emergencyContactPhone) return null;
  return { name, address, latitude, longitude, division, district, emergencyContactPhone, shadeAvailable: data.shade_available === 'on' || data.shade_available === true || data.shade_available === 1, waterAvailable: data.water_available === 'on' || data.water_available === true || data.water_available === 1, restArea: data.rest_area === 'on' || data.rest_area === true || data.rest_area === 1 };
}
function workerDuplicateKey(worker) {
  const phone=normalizePhone(worker.phone)||String(worker.phone||'').replace(/[^0-9+]/g,'');
  return JSON.stringify([String(worker.name||'').trim().replace(/\s+/g,' ').toLocaleLowerCase(),phone,String(worker.siteId||'').trim(),String(worker.jobType||'').trim().toLocaleLowerCase(),String(worker.workload||'').trim().toLocaleLowerCase(),String(worker.shiftStart||'').trim(),String(worker.shiftEnd||'').trim(),String(worker.ageGroup||'').trim().toLowerCase(),Boolean(worker.hasPersonalRiskFactor)]);
}
function assertWorkerIsNotDuplicate(worker, org, excludeId = '') {
  const existing=db.prepare('SELECT id,name,phone,site_id AS siteId,job_type AS jobType,workload,shift_start AS shiftStart,shift_end AS shiftEnd,age_group AS ageGroup,has_personal_risk_factor AS hasPersonalRiskFactor FROM workers WHERE organization_id=?').all(org);
  const duplicate=existing.find(item=>item.id!==excludeId&&workerDuplicateKey(item)===workerDuplicateKey(worker));
  if(duplicate)throw Object.assign(new Error(`Duplicate worker entry: ${worker.name} is already listed at ${worker.site}.`),{status:409});
}
function addWorker(data, org, stamp = now()) {
  const values = workerValues(data, org);
  if (!values) throw Object.assign(new Error('Enter a name, valid phone, site, job type, and workload.'), { status: 400 });
  assertWorkerIsNotDuplicate(values,org);
  const id = token(12);
  db.prepare('INSERT INTO workers(id,organization_id,name,phone,site_id,site,job_type,workload,shift_start,shift_end,age_group,has_personal_risk_factor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, org, values.name, values.phone, values.siteId, values.site, values.jobType, values.workload,values.shiftStart,values.shiftEnd,values.ageGroup,values.hasPersonalRiskFactor?1:0, stamp, stamp);
  return db.prepare('SELECT * FROM workers WHERE id=?').get(id);
}
app.post('/api/workers', csrfAndOrigin, requireUser, async (req, res) => {
  try {
    const current=db.prepare('SELECT COUNT(*) AS n FROM workers WHERE organization_id=?').get(req.user.organization_id).n;
    if(!enforceResourceLimit(req,res,'workers',current))return;
    const worker=addWorker(req.body,req.user.organization_id),sms=await sendWorkerWelcomeSms(worker,req.user.organization_id);
    res.status(201).json({worker,sms});
  }
  catch (error) { sendError(res, error.status || (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400), error.message || 'Could not save worker.'); }
});
app.post('/api/workers/import', csrfAndOrigin, requireUser, requirePlanFeature('csv_import'), async (req, res) => {
  const rows = req.body.workers;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) return sendError(res, 400, 'Choose a CSV with between 1 and 500 worker rows.');
  try {
    const normalized = rows.map(row => workerValues(row, req.user.organization_id));
    if (normalized.some(row => !row)) return sendError(res, 400, 'The CSV contains invalid worker data. Check name, phone, site, job type, workload, and shift times (use HH:mm or Excel times such as 7:00:00 AM); no rows were imported.');
    const existingCount=db.prepare('SELECT COUNT(*) AS n FROM workers WHERE organization_id=?').get(req.user.organization_id).n;
    if(!enforceResourceLimit(req,res,'workers',existingCount,normalized.length))return;
    const stamp = now(),registered=[]; db.exec('BEGIN IMMEDIATE');
    try {
      const keys=new Set();
      for(const row of normalized){
        const key=workerDuplicateKey(row);
        if(keys.has(key))throw Object.assign(new Error(`Duplicate worker entry in CSV: ${row.name} is listed more than once at ${row.site}.`),{status:409});
        keys.add(key);
        assertWorkerIsNotDuplicate(row,req.user.organization_id);
      }
      for (const row of normalized) { const id=token(12);db.prepare('INSERT INTO workers(id,organization_id,name,phone,site_id,site,job_type,workload,shift_start,shift_end,age_group,has_personal_risk_factor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.user.organization_id, row.name, row.phone, row.siteId, row.site, row.jobType, row.workload,row.shiftStart,row.shiftEnd,row.ageGroup,row.hasPersonalRiskFactor?1:0, stamp, stamp);registered.push({id,...row}); }
      db.exec('COMMIT');
    }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    const sms=await sendWorkerWelcomeMessages(registered,req.user.organization_id);
    res.status(201).json({imported:normalized.length,sms});
  } catch (error) { sendError(res, error.status || 400, `${error.message || 'Invalid worker data.'} No rows were imported.`); }
});
app.put('/api/workers', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return sendError(res, 404, 'Not found.');
  try {
    const values = workerValues(req.body, req.user.organization_id);
    if (!values) return sendError(res, 400, 'Enter a name, valid phone, site, job type, and workload.');
    assertWorkerIsNotDuplicate(values,req.user.organization_id,id);
    const result = db.prepare('UPDATE workers SET name=?,phone=?,site_id=?,site=?,job_type=?,workload=?,shift_start=?,shift_end=?,age_group=?,has_personal_risk_factor=?,updated_at=? WHERE id=? AND organization_id=?').run(values.name, values.phone, values.siteId, values.site, values.jobType, values.workload,values.shiftStart,values.shiftEnd,values.ageGroup,values.hasPersonalRiskFactor?1:0, now(), id, req.user.organization_id);
    if (!result.changes) return sendError(res, 404, 'Worker not found.');
    res.json({ worker: db.prepare('SELECT * FROM workers WHERE id=?').get(id) });
  } catch (error) { sendError(res, error.status || 400, error.message); }
});
app.delete('/api/workers', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || ''), result = db.prepare('DELETE FROM workers WHERE id=? AND organization_id=?').run(id, req.user.organization_id);
  if (!result.changes) return sendError(res, 404, 'Worker not found.');
  res.json({ message: 'Worker removed.' });
});
app.post('/api/sites', csrfAndOrigin, requireUser, (req, res) => {
  const values = siteValues(req.body);
  if (!values) return sendError(res, 400, 'Enter a worksite name (up to 120 characters), keep the address under 500 characters, and provide both valid coordinates if setting a map location.');
  const id = token(12), stamp = now();
  if(!enforceResourceLimit(req,res,'sites',db.prepare('SELECT COUNT(*) AS n FROM sites WHERE organization_id=?').get(req.user.organization_id).n))return;
  try {
    db.prepare('INSERT INTO sites(id,organization_id,name,address,latitude,longitude,division,district,emergency_contact_phone,shade_available,water_available,rest_area,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.user.organization_id, values.name, values.address, values.latitude, values.longitude,values.division,values.district,values.emergencyContactPhone,values.shadeAvailable?1:0,values.waterAvailable?1:0,values.restArea?1:0, stamp, stamp);
    res.status(201).json({ site: db.prepare('SELECT id,name,address,latitude,longitude,division,district,emergency_contact_phone,shade_available,water_available,rest_area,created_at,updated_at FROM sites WHERE id=?').get(id) });
  } catch (error) { sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'A worksite with this name already exists in your organization.' : 'Could not save this worksite. Please check the details and try again.'); }
});
app.put('/api/sites', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || ''), values = siteValues(req.body);
  if (!values) return sendError(res, 400, 'Enter a worksite name (up to 120 characters), keep the address under 500 characters, and provide both valid coordinates if setting a map location.');
  try {
    const result = db.prepare('UPDATE sites SET name=?,address=?,latitude=?,longitude=?,division=?,district=?,emergency_contact_phone=?,shade_available=?,water_available=?,rest_area=?,updated_at=? WHERE id=? AND organization_id=?').run(values.name, values.address, values.latitude, values.longitude,values.division,values.district,values.emergencyContactPhone,values.shadeAvailable?1:0,values.waterAvailable?1:0,values.restArea?1:0, now(), id, req.user.organization_id);
    if (!result.changes) return sendError(res, 404, 'Site not found.');
    db.prepare('UPDATE workers SET site=? WHERE site_id=? AND organization_id=?').run(values.name, id, req.user.organization_id);
    WEATHER_CACHE.delete(id);
    res.json({ site: db.prepare('SELECT id,name,address,latitude,longitude,division,district,emergency_contact_phone,shade_available,water_available,rest_area,created_at,updated_at FROM sites WHERE id=?').get(id) });
  } catch (error) { sendError(res, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400, error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'A worksite with this name already exists in your organization.' : 'Could not update this worksite. Please check the details and try again.'); }
});
app.delete('/api/sites', csrfAndOrigin, requireUser, (req, res) => {
  const id = String(req.query.id || ''),org=req.user.organization_id;
  try {
    db.exec('BEGIN IMMEDIATE');
    const site=db.prepare('SELECT id FROM sites WHERE id=? AND organization_id=?').get(id,org);
    if(!site){db.exec('ROLLBACK');return sendError(res,404,'Site not found.');}
    const removedWorkers=db.prepare('DELETE FROM workers WHERE organization_id=? AND site_id=?').run(org,id).changes;
    db.prepare('DELETE FROM sites WHERE id=? AND organization_id=?').run(id,org);
    db.exec('COMMIT');WEATHER_CACHE.delete(id);res.json({message:'Site and its assigned workers removed.',removedWorkers});
  } catch(error) { try{db.exec('ROLLBACK');}catch{} sendError(res,500,'Could not delete the site and its workers.'); }
});
app.post('/api/records/bulk-delete',csrfAndOrigin,requireUser,(req,res)=>{
  const records=req.body.records,allowed=new Set(['workers','sites','breaks','sms','alerts']);
  if(!Array.isArray(records)||!records.length||records.length>500||records.some(item=>!item||!allowed.has(item.type)||typeof item.id!=='string'||!item.id))return sendError(res,400,'Select between 1 and 500 valid records to delete.');
  const org=req.user.organization_id,stamp=now(),unique=[...new Map(records.map(item=>[`${item.type}:${item.id}`,item])).values()],counts={};
  try{
    db.exec('BEGIN IMMEDIATE');
    for(const item of unique){let changed=0;
      if(item.type==='workers')changed=db.prepare('DELETE FROM workers WHERE id=? AND organization_id=?').run(item.id,org).changes;
      else if(item.type==='sites'){
        const site=db.prepare('SELECT id FROM sites WHERE id=? AND organization_id=?').get(item.id,org);
        if(site){const removedWorkers=db.prepare('DELETE FROM workers WHERE organization_id=? AND site_id=?').run(org,item.id).changes;changed=db.prepare('DELETE FROM sites WHERE id=? AND organization_id=?').run(item.id,org).changes;counts.workers=(counts.workers||0)+removedWorkers;WEATHER_CACHE.delete(item.id);}
      }
      else if(item.type==='breaks')changed=db.prepare('DELETE FROM break_logs WHERE id=? AND organization_id=?').run(item.id,org).changes;
      else if(item.type==='sms'){
        if(item.id.startsWith('break-queue-'))changed=db.prepare('DELETE FROM scheduled_break_sms WHERE id=? AND organization_id=?').run(item.id.slice('break-queue-'.length),org).changes;
        else {db.prepare('INSERT INTO sms_deleted_messages(organization_id,id,deleted_at) VALUES(?,?,?) ON CONFLICT(organization_id,id) DO UPDATE SET deleted_at=excluded.deleted_at').run(org,item.id,stamp);changed=db.prepare('DELETE FROM sms_messages WHERE id=? AND organization_id=?').run(item.id,org).changes;}
      }
      else if(item.type==='alerts')changed=db.prepare('DELETE FROM automated_alerts WHERE id=? AND organization_id=?').run(item.id,org).changes;
      counts[item.type]=(counts[item.type]||0)+changed;
    }
    db.exec('COMMIT');res.json({deleted:Object.values(counts).reduce((sum,count)=>sum+count,0),counts});
  }catch(error){try{db.exec('ROLLBACK');}catch{}sendError(res,500,'Could not delete the selected records.');}
});

function weatherSummary(code) {
  const summaries = { 0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Depositing rime fog',51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',56:'Light freezing drizzle',57:'Freezing drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',66:'Light freezing rain',67:'Freezing rain',71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',80:'Light rain showers',81:'Rain showers',82:'Heavy rain showers',85:'Light snow showers',86:'Snow showers',95:'Thunderstorm',96:'Thunderstorm with light hail',99:'Thunderstorm with heavy hail' };
  return summaries[Number(code)] || 'Conditions unavailable';
}
async function openMeteo(site, forecastDays = 1, organizationId = null) {
  const params = new URLSearchParams({ latitude: site.latitude, longitude: site.longitude,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,shortwave_radiation',
    forecast_days: String(forecastDays), timezone: 'auto', temperature_unit: 'celsius', wind_speed_unit: 'ms', precipitation_unit: 'mm' });
  const host = OPEN_METEO_API_KEY ? 'customer-api.open-meteo.com' : 'api.open-meteo.com';
  if (OPEN_METEO_API_KEY) params.set('apikey', OPEN_METEO_API_KEY);
  const started=Date.now(),orgId=organizationId||db.prepare('SELECT organization_id FROM sites WHERE id=?').get(site.id)?.organization_id||null;
  let response;
  try{response=await fetch(`https://${host}/v1/forecast?${params}`, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json', 'User-Agent': 'JibonGuard/1.0' } });}
  catch(error){if(orgId)metering.recordUsage({organizationId:orgId,siteId:site.id,eventType:'weather_api_call',provider:'open_meteo',feature:'weather',quantity:1,unit:'call',status:'failed',idempotencyKey:`weather:${token(16)}`});throw error;}
  const raw = await response.json().catch(() => ({}));
  if(orgId)metering.recordUsage({organizationId:orgId,siteId:site.id,eventType:'weather_api_call',provider:'open_meteo',feature:'weather',quantity:1,unit:'call',status:response.ok&&raw.current?'success':'failed',latencyMs:Date.now()-started,idempotencyKey:`weather:${token(16)}`});
  if (!response.ok || !raw.current) throw new Error(response.status === 429 ? 'Open-Meteo request limit reached. Weather will be available again shortly.' : response.status === 401 || response.status === 403 ? 'Open-Meteo rejected the customer API key. Check OPEN_METEO_API_KEY in .env.' : raw.reason || `Open-Meteo could not return weather right now (HTTP ${response.status}).`);
  return raw;
}
async function timezoneForSite(siteId, organizationId) {
  const cached=SITE_TIMEZONES.get(siteId);
  if(cached&&cached.expires>Date.now())return cached.value;
  const weather=ALERT_WEATHER_CACHE.get(siteId)?.raw;
  if(weather?.timezone){SITE_TIMEZONES.set(siteId,{value:weather.timezone,expires:Date.now()+6*3600000});return weather.timezone;}
  const site=db.prepare('SELECT id,latitude,longitude FROM sites WHERE id=? AND organization_id=?').get(siteId,organizationId);
  if(site?.latitude!=null&&site?.longitude!=null){try{const raw=await openMeteo(site,1,organizationId);if(raw.timezone){SITE_TIMEZONES.set(siteId,{value:raw.timezone,expires:Date.now()+6*3600000});return raw.timezone;}}catch{}}
  return 'Asia/Dhaka';
}
function workerIsOnShift(worker, at=new Date(), timezone='Asia/Dhaka') {
  const start=String(worker.shift_start||worker.shiftStart||''),end=String(worker.shift_end||worker.shiftEnd||''),parse=value=>{const match=value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);return match?Number(match[1])*60+Number(match[2]):null;};
  const startMinute=parse(start),endMinute=parse(end);
  if(startMinute==null||endMinute==null||startMinute===endMinute)return false;
  let parts;try{parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(part=>[part.type,part.value]));}catch{parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(part=>[part.type,part.value]));}
  const minute=Number(parts.hour)*60+Number(parts.minute);
  return startMinute<endMinute?minute>=startMinute&&minute<endMinute:minute>=startMinute||minute<endMinute;
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
  try { const result = shapeWeather(await openMeteo(site,1,req.user.organization_id)); WEATHER_CACHE.set(cacheKey, { expires:Date.now()+600000,value:result }); res.json({ site_id:site.id,weather:result,cached:false }); }
  catch (error) { sendError(res, 502, error.message || "Could not reach Open-Meteo. Check the server's internet connection and try again."); }
});
app.get('/api/geocode/search', requireUser, async (req, res) => {
  const query = String(req.query.q || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 200) return sendError(res, 400, 'Enter at least 2 characters to search for a place.');
  const key = `search:${query.toLocaleLowerCase()}`, cached = GEO_CACHE.get(key);
  if (cached && cached.expires > Date.now()) return res.json(cached.value);
  const requestId=token(16),started=Date.now();let metered=false;
  try {
    const response = await fetch(`https://photon.komoot.io/api/?${new URLSearchParams({q:query,limit:'5',lang:'en'})}`, { signal:AbortSignal.timeout(8000),headers:{Accept:'application/json','User-Agent':`JibonGuard/1.0 (${PUBLIC_ORIGIN})`} });
    metering.recordUsage({organizationId:req.user.organization_id,eventType:'geocode_call',provider:'photon',feature:'search',quantity:1,unit:'call',status:response.ok?'success':'failed',latencyMs:Date.now()-started,idempotencyKey:`geocode:${requestId}`});metered=true;
    if (!response.ok) return sendError(res, 502, `Place search failed (HTTP ${response.status}). Try again shortly.`);
    const json = await response.json(), results = (json.features || []).flatMap(feature => {
      const [longitude,latitude] = feature.geometry?.coordinates || [], p = feature.properties || {};
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) return [];
      const name = String(p.name || p.street || p.city || '').trim(), address = [name,[p.housenumber,p.street].filter(Boolean).join(' '),p.postcode,p.city,p.district,p.county,p.state,p.country].filter(Boolean);
      return [{ latitude,longitude,name:name.slice(0,120),display_name:[...new Set(address)].join(', ').slice(0,500) }];
    });
    const value = { results }; GEO_CACHE.set(key,{expires:Date.now()+86400000,value}); res.json(value);
  } catch { if(!metered)metering.recordUsage({organizationId:req.user.organization_id,eventType:'geocode_call',provider:'photon',feature:'search',quantity:1,unit:'call',status:'failed',latencyMs:Date.now()-started,idempotencyKey:`geocode:${requestId}`});sendError(res, 502, 'Could not retrieve place suggestions. Check your connection or select a point directly on the map.'); }
});
app.get('/api/geocode/reverse', requireUser, async (req, res) => {
  const latitude = Number(req.query.lat), longitude = Number(req.query.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180) return sendError(res, 400, 'Choose a valid point on the map.');
  const key = `reverse:${latitude.toFixed(5)},${longitude.toFixed(5)}`, cached = GEO_CACHE.get(key);
  if (cached && cached.expires>Date.now()) return res.json(cached.value);
  const requestId=token(16),started=Date.now();let metered=false;
  try {
    const params=new URLSearchParams({format:'jsonv2',lat:String(latitude),lon:String(longitude),zoom:'18',addressdetails:'1'});
    const response=await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json','User-Agent':`JibonGuard/1.0 (site location picker; ${PUBLIC_ORIGIN})`,Referer:`${PUBLIC_ORIGIN}/dashboard.html`}});
    metering.recordUsage({organizationId:req.user.organization_id,eventType:'geocode_call',provider:'nominatim',feature:'reverse',quantity:1,unit:'call',status:response.ok?'success':'failed',latencyMs:Date.now()-started,idempotencyKey:`geocode:${requestId}`});metered=true;
    const result=await response.json(); if(!response.ok||!result.display_name)return sendError(res,response.status===404?404:502,'Could not retrieve this place from OpenStreetMap. You can still save the coordinates.');
    const address=result.address||{}, name=result.name||address.building||address.amenity||address.road||address.neighbourhood||address.suburb||address.village||address.town||address.city||'';
    const value={latitude,longitude,display_name:result.display_name,name:String(name).slice(0,120),address}; GEO_CACHE.set(key,{expires:Date.now()+604800000,value}); res.json(value);
  } catch { if(!metered)metering.recordUsage({organizationId:req.user.organization_id,eventType:'geocode_call',provider:'nominatim',feature:'reverse',quantity:1,unit:'call',status:'failed',latencyMs:Date.now()-started,idempotencyKey:`geocode:${requestId}`});sendError(res, 502, 'Could not retrieve this place from OpenStreetMap. You can still save the coordinates.'); }
});

async function geminiGenerate(contents, instruction, jsonResponse = false, { organizationId = null, feature = 'chat' } = {}) {
  if (!GEMINI_API_KEY) throw new Error('Gemini is not configured. Set GEMINI_API_KEY in the server .env file.');
  const started=Date.now(),inputText=`${instruction}\n${JSON.stringify(contents)}`;
  const recordGemini=(status,usage,latency)=>metering.recordUsage({organizationId,eventType:'ai_call',provider:'gemini',feature,quantity:usage.inputTokens+usage.outputTokens,unit:'token',rateDivisor:1000000,tokensInput:usage.inputTokens,tokensOutput:usage.outputTokens,estimated:usage.estimated,status,model:GEMINI_MODEL,latencyMs:latency,metadata:{estimated:usage.estimated},idempotencyKey:`gemini:${token(16)}`});
  const generationConfig = { maxOutputTokens:700 };
  if (GEMINI_MODEL.startsWith('gemini-3')) generationConfig.thinkingConfig={thinkingLevel:GEMINI_MODEL==='gemini-3.5-flash-lite'?'minimal':'low'};
  if (jsonResponse) generationConfig.responseMimeType='application/json';
  let response;
  try { response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,{method:'POST',signal:AbortSignal.timeout(50000),headers:{'x-goog-api-key':GEMINI_API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:instruction}]},contents,generationConfig})}); }
  catch { const usage={...estimateGeminiTokens(inputText,''),outputTokens:0};recordGemini('failed',usage,Date.now()-started);throw new Error("Could not connect to Gemini. Check the server's internet connection."); }
  const result=await response.json().catch(()=>({}));
  const candidate=result.candidates?.[0]||{}, answer=(candidate.content?.parts||[]).map(part=>part.text||'').join('\n').trim();
  const metadata=result.usageMetadata||{},estimate=estimateGeminiTokens(inputText,answer),usage={inputTokens:Number.isSafeInteger(metadata.promptTokenCount)?metadata.promptTokenCount:estimate.inputTokens,outputTokens:Number.isSafeInteger(metadata.candidatesTokenCount)?metadata.candidatesTokenCount:estimate.outputTokens,estimated:!Number.isSafeInteger(metadata.promptTokenCount)||!Number.isSafeInteger(metadata.candidatesTokenCount)};
  if (!response.ok) { recordGemini('failed',usage,Date.now()-started);const detail=String(result.error?.message||'').replace(/\s+/g,' ').slice(0,240); throw new Error(`Gemini returned HTTP ${response.status}.${detail?` ${detail}`:' Check the server key, model and API quota.'}`); }
  recordGemini(answer?'success':'failed',usage,Date.now()-started);
  if (!answer) throw new Error(`Gemini returned no text${candidate.finishReason?` (${candidate.finishReason})`:''}. Check the model/key or rephrase the prompt.`);
  return answer;
}
app.post('/api/ai/chat', csrfAndOrigin, requireUser, async (req,res) => {
  if(!checkFeatureAccess(db,req.user.organization_id,'ai_chat').allowed)return sendError(res,402,'AI chat is not included in your current plan.');
  if (!rateAllowed(req,'gemini-chat',20,3600)) return sendError(res,429,'Chat limit reached. Try again in a little while.');
  const messages=req.body.messages;
  if (!Array.isArray(messages)||!messages.length||messages.length>12) return sendError(res,400,'Send a short chat message and try again.');
  const contents=messages.slice(-10).filter(item=>item&&['user','model'].includes(item.role)&&typeof item.text==='string'&&item.text.trim()&&item.text.length<=1200).map(item=>({role:item.role,parts:[{text:item.text.trim()}]}));
  if (!contents.length||contents.at(-1).role!=='user') return sendError(res,400,'Enter a message to continue.');
  const promptText=contents.map(message=>message.parts.map(part=>part.text||'').join('')).join('\n'),estimatedUsage=estimateGeminiTokens(promptText,''),quota=checkUsageDispatch(db,{organizationId:req.user.organization_id,eventType:'ai_call',quantity:estimatedUsage.inputTokens+256});if(!quota.allowed)return sendError(res,402,'AI usage is paused because this organization reached its plan limit or needs to restore its subscription.');
  const attachment=req.body.attachment;
  if(attachment!==undefined){
    if(!attachment||typeof attachment!=='object'||typeof attachment.name!=='string'||attachment.name.length>160)return sendError(res,400,'Choose a valid attachment.');
    const name=path.basename(attachment.name),extension=path.extname(name).toLowerCase();
    if(['.txt','.md'].includes(extension)){
      if(typeof attachment.text!=='string'||attachment.text.length>100000)return sendError(res,400,'Text and Markdown files must contain 100,000 characters or fewer.');
      contents.at(-1).parts.push({text:`\n\nAttached ${extension==='.md'?'Markdown':'text'} file (${name}):\n${attachment.text}`});
    }else{
      const mimeType=String(attachment.mimeType||'').toLowerCase(),allowedImages=new Set(['image/png','image/jpeg','image/webp','image/gif']);
      if(extension!=='.pdf'&&!allowedImages.has(mimeType))return sendError(res,400,'Use a PDF, PNG, JPG, WEBP, or GIF image, or a TXT/MD file.');
      if(extension==='.pdf'&&mimeType!=='application/pdf')return sendError(res,400,'The selected PDF file has an invalid content type.');
      const data=attachment.data;
      if(typeof data!=='string'||data.length>14_000_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))return sendError(res,400,'Attachment is invalid or larger than 10 MB.');
      const bytes=Buffer.from(data,'base64');
      if(!bytes.length||bytes.length>10*1024*1024||bytes.toString('base64')!==data)return sendError(res,400,'Attachment is invalid or larger than 10 MB.');
      const validPdf=extension==='.pdf'&&bytes.subarray(0,5).toString('ascii')==='%PDF-';
      const validImage=(mimeType==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(mimeType==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(mimeType==='image/gif'&&/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii')))||(mimeType==='image/webp'&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP');
      if(!validPdf&&!validImage)return sendError(res,400,'The attachment content does not match its file type.');
      contents.at(-1).parts.push({text:`Attached file: ${name}`},{inline_data:{mime_type:mimeType,data}});
    }
  }
  const instruction="You are JibonGuard's in-app assistant. Help organization administrators understand the dashboard, site weather, worker consent, break logs, and practical heat and weather safety. Be concise and clear. Do not claim to see private organization records or live weather unless supplied in the conversation. Never give a medical diagnosis or claim an emergency is safe; direct urgent situations to local emergency services and official instructions. Do not ask for passwords, API keys, or personal worker details.";
  try { res.json({ reply:await geminiGenerate(contents,instruction,false,{organizationId:req.user.organization_id,feature:'chat'}) }); } catch(error) { sendError(res,503,error.message); }
});
app.post('/api/ai/speech', csrfAndOrigin, requireUser, requirePlanFeature('voice_alerts'), async (req,res) => {
  if (!rateAllowed(req,'gemini-speech',30,3600)) return sendError(res,429,'Speech limit reached. Try again in a little while.');
  const text=typeof req.body.text==='string'?req.body.text.trim():'';
  const voice=String(req.body.voice||'Kore');
  if(!text||text.length>5000)return sendError(res,400,'Choose a reply with 1 to 5,000 characters to read aloud.');
  if(!['Kore','Puck','Charon','Aoede'].includes(voice))return sendError(res,400,'Choose one of the available assistant voices.');
  let response;const started=Date.now(),estimatedInput=estimateGeminiTokens(text,'');
  const quota=checkUsageDispatch(db,{organizationId:req.user.organization_id,eventType:'ai_call',quantity:estimatedInput.inputTokens});if(!quota.allowed)return sendError(res,402,'Speech generation is paused because this organization reached its plan limit or needs to restore its subscription.');
  if(!GEMINI_API_KEY)return sendError(res,503,'Gemini is not configured. Set GEMINI_API_KEY in the server .env file.');
  try{
    response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_TTS_MODEL)}:generateContent`,{method:'POST',signal:AbortSignal.timeout(60000),headers:{'x-goog-api-key':GEMINI_API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text,speech_metadata:{style:'Clear, calm, conversational delivery.'}}]}],generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{voice}}}})});
  }catch{metering.recordUsage({organizationId:req.user.organization_id,eventType:'ai_call',provider:'gemini',feature:'speech',quantity:estimatedInput.inputTokens,unit:'token',rateDivisor:1000000,tokensInput:estimatedInput.inputTokens,tokensOutput:0,estimated:true,status:'failed',model:GEMINI_TTS_MODEL,latencyMs:Date.now()-started,idempotencyKey:`gemini-tts:${token(16)}`});return sendError(res,503,"Could not connect to Gemini speech. Check the server's internet connection.");}
  const result=await response.json().catch(()=>({}));
  const usageMeta=result.usageMetadata||{},tokensInput=Number.isSafeInteger(usageMeta.promptTokenCount)?usageMeta.promptTokenCount:estimatedInput.inputTokens,tokensOutput=Number.isSafeInteger(usageMeta.candidatesTokenCount)?usageMeta.candidatesTokenCount:0,estimated=!Number.isSafeInteger(usageMeta.promptTokenCount)||!Number.isSafeInteger(usageMeta.candidatesTokenCount);
  if(!response.ok){metering.recordUsage({organizationId:req.user.organization_id,eventType:'ai_call',provider:'gemini',feature:'speech',quantity:tokensInput+tokensOutput,unit:'token',rateDivisor:1000000,tokensInput,tokensOutput,estimated,status:'failed',model:GEMINI_TTS_MODEL,latencyMs:Date.now()-started,idempotencyKey:`gemini-tts:${token(16)}`});const detail=String(result.error?.message||'').replace(/\s+/g,' ').slice(0,220);return sendError(res,503,`Gemini speech returned HTTP ${response.status}.${detail?` ${detail}`:' Check TTS model access and API quota.'}`);}
  const audioPart=(result.candidates?.[0]?.content?.parts||[]).find(part=>part.inlineData?.data);
  metering.recordUsage({organizationId:req.user.organization_id,eventType:'ai_call',provider:'gemini',feature:'speech',quantity:tokensInput+tokensOutput,unit:'token',rateDivisor:1000000,tokensInput,tokensOutput,estimated,status:audioPart?'success':'failed',model:GEMINI_TTS_MODEL,latencyMs:Date.now()-started,idempotencyKey:`gemini-tts:${token(16)}`});
  if(!audioPart)return sendError(res,503,'Gemini returned no speech audio. Check TTS model access and try again.');
  res.set('Cache-Control','no-store').json({audio:audioPart.inlineData.data,mime_type:audioPart.inlineData.mimeType||'audio/wav'});
});
app.post('/api/ai/live-token', csrfAndOrigin, requireUser, requirePlanFeature('voice_alerts'), async (req,res) => {
  if (!rateAllowed(req,'gemini-live-token',10,3600)) return sendError(res,429,'Live voice is temporarily limited. Try again in a little while.');
  if (!GEMINI_API_KEY) return sendError(res,503,'Gemini is not configured. Set GEMINI_API_KEY in the server .env file.');
  let response;
  try {
    const expiresAt=new Date(Date.now()+30*60*1000).toISOString();
    response=await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens',{method:'POST',signal:AbortSignal.timeout(15000),headers:{'x-goog-api-key':GEMINI_API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({uses:1,expireTime:expiresAt,newSessionExpireTime:new Date(Date.now()+60*1000).toISOString()})});
  } catch { return sendError(res,503,"Could not connect to Gemini Live. Check the server's internet connection."); }
  const result=await response.json().catch(()=>({}));
  if (!response.ok||typeof result.name!=='string') { const detail=String(result.error?.message||'').replace(/\s+/g,' ').slice(0,220); return sendError(res,503,`Gemini Live token request failed${response.status?` (HTTP ${response.status})`:''}.${detail?` ${detail}`:' Check Live API access, model availability and API quota.'}`); }
  res.set('Cache-Control','no-store').json({token:result.name,model:'models/gemini-3.8-live'});
});

async function sendTextBeeBreakSms(recipients, record, usageContext={}) {
  if (!recipients.length) return { status:'no_recipients',recipient_count:0,message:'No consented workers with usable phone numbers are assigned to this site.' };
  const apiKey=(process.env.TEXTBEE_API_KEY||process.env.TEXTBEE_DEV_API||'').trim(), subscription=(process.env.TEXTBEE_SIM_SUBSCRIPTION_ID||process.env.SIM_SUBSCRIPTION_ID||'').trim(), base=(process.env.TEXTBEE_BASE_URL||'https://api.textbee.dev/api/v1').replace(/\/$/,'');
  if (!apiKey) return {status:'not_configured',recipient_count:0,message:'Break saved, but SMS is not configured. Set TEXTBEE_API_KEY in JibonGuard AI/.env.'};
  if (subscription && !/^\d+$/.test(subscription)) return {status:'not_configured',recipient_count:0,message:'Break saved, but the configured TextBee SIM ID is invalid. Clear TEXTBEE_SIM_SUBSCRIPTION_ID to use the device default SIM.'};
  if (!base.startsWith('https://')) return {status:'not_configured',recipient_count:0,message:'Break saved, but SMS configuration must use an HTTPS TextBee API URL.'};
  const alertCopy={
    rain:`বৃষ্টি হলে খোলা জায়গায় কাজ বন্ধ করে নিরাপদ আচ্ছাদিত স্থানে যান। পিচ্ছিল বা জলাবদ্ধ এলাকা এড়িয়ে সাইটের নির্দেশনা মানুন। কর্মস্থল: ${record.site}`,
    storm:`ঝড়ের সতর্কতা: বাইরে কাজ বন্ধ করে নির্ধারিত নিরাপদ আশ্রয়ে যান। গাছ, বৈদ্যুতিক খুঁটি ও ধাতব কাঠামো থেকে দূরে থাকুন। কর্মস্থল: ${record.site}`,
    earthquake:`ভূমিকম্প: নিচু হন, মজবুত কিছুর নিচে আশ্রয় নিন এবং ধরে থাকুন। জানালা ও ভারী জিনিস থেকে দূরে থাকুন। কম্পন থামলে সাইটের নির্দেশনা মানুন। কর্মস্থল: ${record.site}`
  };
  const plannedAt=Number(record.scheduled_at)||Math.floor(new Date(`${record.break_date}T${record.break_time}:00`).getTime()/1000);
  const remaining=plannedAt-now(), timing=remaining>0?`Break starts in ${Math.max(1,Math.ceil(remaining/60))} minutes, at ${record.break_time}.`:`Break time: ${record.break_date} at ${record.break_time}.`;
  const messages=recipients.map(recipient=>{
    const name=recipient.name||'কর্মী';
    const message=alertCopy[record.alert_type]
      ? `${name}, ${alertCopy[record.alert_type]}। - JibonGuard`
      : `${name}, বিরতির সময় হয়েছে। ${record.site} কর্মস্থলে ${record.duration_minutes} মিনিট পানি পান করুন ও ছায়ায় বিশ্রাম নিন। সময়: ${record.break_date} ${record.break_time}। - JibonGuard`;
    return {recipients:[recipient.phone],message:`${message} ${timing}`,...(subscription?{simSubscriptionId:Number(subscription)}:{})};
  });
  const meterEntries=messages.flatMap(item=>item.recipients.map(phone=>({phone,message:item.message,refId:recipients.find(row=>row.phone===phone)?.refId})));
  const quota=smsQuotaDecision(messages,usageContext);if(!quota.allowed){meterSmsAttempt(messages.flatMap(item=>item.recipients.map(phone=>({phone,message:item.message}))),usageContext,'blocked',token(16));return {status:'quota_blocked',recipient_count:0,message:'Routine SMS is paused because this organization has reached its plan limit or needs to restore its subscription.'};}
  try {
    const messageTemplate=({break:'পানি পান ও ছায়ায় বিরতি',rain:'বৃষ্টি সতর্কতা',storm:'ঝড় সতর্কতা',earthquake:'ভূমিকম্প সতর্কতা'})[record.alert_type]||'নিরাপত্তা সতর্কতা';
    const response=await fetch(`${base}/gateway/send-bulk-sms`,{method:'POST',signal:AbortSignal.timeout(20000),headers:{'x-api-key':apiKey,'Content-Type':'application/json',Accept:'application/json','User-Agent':'JibonGuard/1.0 (site break notifications)'},body:JSON.stringify({messages,messageTemplate})});
    const result=await response.json().catch(()=>({}));
    if (!response.ok) {meterSmsAttempt(meterEntries,usageContext,'failed',token(16));const detail=String(result.message||result.error?.message||result.data?.message||'').replace(/\s+/g,' ').slice(0,180); return {status:'failed',recipient_count:0,message:response.status===401?'Break saved, but TextBee rejected the API key. Check TEXTBEE_API_KEY.':response.status===429?"Break saved, but TextBee's sending limit was reached.":`Break saved, but TextBee returned HTTP ${response.status}.${detail?` ${detail}`:' Check that a default device is enabled and online.'}`}; }
    const accepted=result.data?.success===true||Number(result.data?.successCount)>0;
    if (!accepted) {meterSmsAttempt(meterEntries,usageContext,'failed',token(16));const failed=Number(result.data?.failureCount)||0; return {status:'failed',recipient_count:0,message:failed?`Break saved, but TextBee could not queue ${failed} SMS. Check device status and recipient numbers.`:'Break saved, but TextBee did not confirm the batch. Check that a default sending device is enabled and online.'}; }
    const acceptedCount=Number(result.data?.recipientCount||result.data?.successCount)||recipients.length;
    meterSmsAttempt(meterEntries,usageContext,'queued',token(16));
    return {status:'queued',recipient_count:acceptedCount,message:`TextBee accepted ${acceptedCount} personalized SMS message(s) into its queue.`};
  } catch { meterSmsAttempt(meterEntries,usageContext,'failed',token(16));return {status:'failed',recipient_count:0,message:'Break saved, but the TextBee request timed out or failed. Retry shortly.'}; }
}
function queueBreakSms(orgId, breakId, recipients, record, scheduledAt) {
  const insert=db.prepare("INSERT INTO scheduled_break_sms(id,organization_id,break_id,worker_id,workload,recipient,message,scheduled_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,'scheduled',?)");
  const stamp=now();
  for(const recipient of recipients) insert.run(token(12),orgId,breakId,recipient.worker_id||null,recipient.workload||'',recipient.phone,`JibonGuard: ${record.title} at ${record.site}. Break starts at ${record.break_time} on ${record.break_date} for ${record.duration_minutes} minutes.`,scheduledAt,stamp);
  return recipients.length;
}
let breakSmsDispatchRunning=false;
async function dispatchScheduledBreakSms() {
  if(breakSmsDispatchRunning)return;
  breakSmsDispatchRunning=true;
  try {
    const due=db.prepare("SELECT DISTINCT break_id,organization_id FROM scheduled_break_sms WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 30").all(now());
    for(const item of due) {
      const claim=db.prepare("UPDATE scheduled_break_sms SET status='sending' WHERE break_id=? AND organization_id=? AND status='scheduled'").run(item.break_id,item.organization_id);
      if(!claim.changes)continue;
      const rows=db.prepare("SELECT id,worker_id,workload,recipient FROM scheduled_break_sms WHERE break_id=? AND organization_id=? AND status='sending'").all(item.break_id,item.organization_id);
      const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,alert_type,status,workload_levels FROM break_logs WHERE id=? AND organization_id=?').get(item.break_id,item.organization_id);
      if(!record){db.prepare("UPDATE scheduled_break_sms SET status='failed',error='Safety log was removed.' WHERE break_id=? AND organization_id=? AND status='sending'").run(item.break_id,item.organization_id);continue;}
      let workloadLevels=[];try{workloadLevels=JSON.parse(record.workload_levels||'[]');}catch{}
      const firstWorker=rows.map(row=>row.worker_id&&db.prepare('SELECT site_id FROM workers WHERE id=? AND organization_id=?').get(row.worker_id,item.organization_id)).find(Boolean),timezone=firstWorker?await timezoneForSite(firstWorker.site_id,item.organization_id):'Asia/Dhaka';
      const recipients=[];
      for(const row of rows){
        const worker=row.worker_id?db.prepare('SELECT id,name,phone,consent_at,workload,shift_start,shift_end FROM workers WHERE id=? AND organization_id=?').get(row.worker_id,item.organization_id):null;
        let error='';
        if(!worker||!worker.consent_at)error='Worker consent is not active at send time.';
        else if(normalizePhone(worker.phone)!==normalizePhone(row.recipient))error='Worker phone changed before send.';
        else if(workloadLevels.length&&!workloadLevels.includes(worker.workload))error='Worker workload is no longer selected for this alert.';
        else if(!workerIsOnShift(worker,new Date(),timezone))error='Worker is outside their shift at send time.';
        if(error){db.prepare("UPDATE scheduled_break_sms SET status='failed',error=? WHERE id=? AND organization_id=? AND status='sending'").run(error,row.id,item.organization_id);continue;}
        recipients.push({phone:row.recipient,name:worker.name,refId:row.id});
      }
      if(!recipients.length)continue;
      const result=await sendTextBeeBreakSms(recipients,{...record,status:'scheduled',scheduled_at:item.scheduled_at},{organizationId:item.organization_id,feature:'break_planner'});
      const success=result.status==='queued';
      db.prepare("UPDATE scheduled_break_sms SET status=?,sent_at=?,error=? WHERE break_id=? AND organization_id=? AND status='sending'").run(success?'sent':'failed',success?now():null,success?'':result.message,item.break_id,item.organization_id);
    }
  } catch(error) { console.error(`Scheduled break SMS dispatch failed (${error.name})`); }
  finally {breakSmsDispatchRunning=false;}
}
const EMERGENCY_CODES = {
  '0': {label:'নির্দেশিকা',reply:'জীবনগার্ড নির্দেশিকা: বিপদে শুধু সংখ্যা লিখে পাঠান। ১ দুর্ঘটনা/সাহায্য, ২ আগুন, ৩ গরমে অসুস্থ, ৪ সহকর্মী অজ্ঞান, ৫ বিদ্যুৎ বিপদ, ৬ পড়ে যাওয়া/ধস, ৭ ঝড়-বজ্রপাত, ৮ গ্যাস/ধোঁয়া, ৯ অন্য বিপদ। জীবন বিপন্ন হলে ৯৯৯ এ কল করুন।'},
  '1': {label:'দুর্ঘটনা / সাহায্য',reply:'জীবনগার্ড: দুর্ঘটনার খবর পেয়েছি। সাহায্য আসছে। নিরাপদ জায়গায় থাকুন।'},
  '2': {label:'আগুন',reply:'জীবনগার্ড: আগুনের খবর পেয়েছি। এখনই নিরাপদ জায়গায় সরে যান। ফায়ার সার্ভিসকে জানানো হচ্ছে।'},
  '3': {label:'গরমে অসুস্থতা',reply:'জীবনগার্ড: আপনার অসুস্থতার খবর পেয়েছি। ছায়ায় বসুন, পানি পান করুন। সাহায্য আসছে।'},
  '4': {label:'সহকর্মী অজ্ঞান বা গুরুতর অসুস্থ',reply:'জীবনগার্ড: সহকর্মীর খবর পেয়েছি। তাকে ছায়ায় শোয়ান, বাতাস দিন। জ্ঞান থাকলে পানি দিন। সাহায্য আসছে।'},
  '5': {label:'বিদ্যুতের বিপদ',reply:'জীবনগার্ড: বিদ্যুৎ বিপদের খবর পেয়েছি। কাউকে ছোঁবেন না, লাইন বন্ধ করানো হচ্ছে। সাহায্য আসছে।'},
  '6': {label:'উঁচু থেকে পড়ে যাওয়া / ধস',reply:'জীবনগার্ড: দুর্ঘটনার খবর পেয়েছি। আহতকে নাড়াবেন না। সাহায্য আসছে।'},
  '7': {label:'ঝড় / বজ্রপাতের বিপদ',reply:'জীবনগার্ড: ঝড়/বজ্রপাতের সতর্কতা পাঠানো হয়েছে। এখনই পাকা ঘরে আশ্রয় নিন। খোলা জায়গা ও ধাতব জিনিস থেকে দূরে থাকুন।'},
  '8': {label:'গ্যাস লিক / বিষাক্ত ধোঁয়া',reply:'জীবনগার্ড: গ্যাস/ধোঁয়ার খবর পেয়েছি। এখনই খোলা বাতাসে সরে যান। আগুন বা সুইচ জ্বালাবেন না।'},
  '9': {label:'অন্য জরুরি সমস্যা',reply:'জীবনগার্ড: আপনার বার্তা পেয়েছি। সুপারভাইজার শীঘ্রই যোগাযোগ করবেন।'},
};
function smsPhoneKeys(value) {
  const ascii=String(value||'').replace(/[\u09e6-\u09ef]/g,digit=>String(digit.charCodeAt(0)-0x09e6));
  const digits=ascii.replace(/\D/g,'');
  return [...new Set([normalizePhone(ascii),digits.length>=10?digits.slice(-10):null].filter(Boolean))];
}
function emergencySmsCode(message) {
  const value=toAsciiDigits(String(message||'').trim());
  return /^[0-9]$/.test(value)&&EMERGENCY_CODES[value]?value:null;
}
function weatherSlotIndex(times,currentTime){const current=String(currentTime||'').slice(0,16);return Math.max(0,times.findIndex(value=>String(value)>=current));}
async function buildAlertContexts(site,organizationId,config,{simulation=null}={}){
  let raw,age=0,delayed=false;
  try{raw=await openMeteo(site,2,organizationId);ALERT_WEATHER_CACHE.set(site.id,{raw,fetchedAt:Date.now()});}
  catch(error){const cached=ALERT_WEATHER_CACHE.get(site.id);if(cached){raw=cached.raw;age=(Date.now()-cached.fetchedAt)/60000;delayed=age>config.staleWeatherMinutes;}else{raw={current:{},hourly:{time:[]},timezone:'UTC'};age=config.staleWeatherMinutes+1;delayed=true;}console.error(`Alert weather fetch failed ${site.id}: ${error.name}`);}
  ALERT_WEATHER_STATUS.set(`${organizationId}:${site.id}`,{delayed,age,updatedAt:Date.now()});
  const current=raw.current||{},hourly=raw.hourly||{},times=hourly.time||[],start=weatherSlotIndex(times,current.time),slots=[];
  for(let i=start;i<times.length&&i<start+7;i++)slots.push({time:times[i],temperatureC:hourly.temperature_2m?.[i]??null,apparentC:hourly.apparent_temperature?.[i]??null,rainProbability:Number(hourly.precipitation_probability?.[i])||0,precipitation:Number(hourly.precipitation?.[i])||0,weatherCode:Number(hourly.weather_code?.[i])||0,windSpeed:Number(hourly.wind_speed_10m?.[i])||0,solar:Number(hourly.shortwave_radiation?.[i])||0});
  const nowDate=new Date();if(simulation?.timeOfDay){const [hour,minute]=simulation.timeOfDay.split(':').map(Number);nowDate.setHours(hour,minute,0,0);}const currentStamp=Date.parse(`${String(current.time||'').slice(0,16)}:00Z`),rainForecast=slots.map(slot=>({slot,etaMinutes:Math.max(0,Math.round((Date.parse(`${slot.time}:00Z`)-currentStamp)/60000))})).find(({slot,etaMinutes})=>etaMinutes<=360&&(slot.rainProbability>=config.rainProbability||slot.precipitation>=0.2||[51,53,55,61,63,65,80,81,82].includes(slot.weatherCode)));
  const lightning=slots.some(slot=>[95,96,99].includes(slot.weatherCode));
  const weather={temperatureC:simulation?simulation.temperatureC:Number(current.temperature_2m),apparentC:simulation?simulation.temperatureC:Number(current.apparent_temperature),wbgtC:null,humidity:Number(current.relative_humidity_2m),solar:slots[0]?.solar??0,windSpeed:Number(current.wind_speed_10m),currentPrecipitation:simulation?0:Number(current.precipitation)||0,weatherCode:simulation?0:Number(current.weather_code),lightning, rainProbability:simulation?(simulation.rainEtaMinutes!=null&&simulation.rainEtaMinutes<=config.rainLeadMinutes?config.rainProbability:0):(rainForecast?.slot.rainProbability||0),rainEtaMinutes:simulation?simulation.rainEtaMinutes:(rainForecast?.etaMinutes??null),expectedRainStart:simulation?.rainEtaMinutes==null?null:rainForecast?.slot.time||null,forecast:slots,dataAgeMinutes:age,weatherDelayed:delayed,timezone:raw.timezone||'UTC',officialHeatwave:false};
  const workers=db.prepare(`SELECT w.*,COALESCE((SELECT action FROM worker_consent_events e WHERE e.worker_id=w.id ORDER BY e.changed_at DESC,e.rowid DESC LIMIT 1),'pending') AS consent_status FROM workers w WHERE w.organization_id=? AND w.site_id=? ORDER BY w.id`).all(organizationId,site.id);
  return workers.map(worker=>{
    const lastBreak=worker.last_break?new Date(worker.last_break):null,continuousHours=lastBreak&&!Number.isNaN(lastBreak.getTime())?Math.max(0,(nowDate-lastBreak)/3600000):Number(worker.outdoor_minutes||0)/60;
    const lastAlerts=db.prepare('SELECT alert_type,MAX(COALESCE(sent_at,scheduled_at)) AS at FROM automated_alerts WHERE organization_id=? AND worker_id=? AND status IN (\'sent\',\'scheduled\',\'queued\') GROUP BY alert_type ORDER BY at DESC').all(organizationId,worker.id);
    const lastByType=Object.fromEntries(lastAlerts.filter(item=>item.at).map(item=>[item.alert_type,new Date(item.at*1000).toISOString()]));
    const today=new Date();today.setHours(0,0,0,0);const sentToday=db.prepare("SELECT COUNT(*) AS n FROM automated_alerts WHERE organization_id=? AND worker_id=? AND created_at>=? AND status IN ('sent','queued','scheduled')").get(organizationId,worker.id,Math.floor(today.getTime()/1000)).n;
    const context={worker:{id:worker.id,jobType:worker.job_type,workload:worker.workload,riskLevel:worker.risk_level,consentStatus:worker.consent_status,consentAt:worker.consent_at,shiftStart:worker.shift_start,shiftEnd:worker.shift_end,newWorker:worker.created_at>now()-14*86400,ageGroup:worker.age_group,hasPersonalRiskFactor:Boolean(worker.has_personal_risk_factor),continuousHours},state:{continuousHours,totalHoursToday:Number(worker.outdoor_minutes||0)/60,lastBreak:worker.last_break||null,lastAlertLevel:lastAlerts[0]?.alert_type||null,lastAlertTime:lastAlerts[0]?.at?new Date(lastAlerts[0].at*1000).toISOString():null,alertsSentToday:sentToday,lastAcknowledgement:null},site:{id:site.id,shadeAvailable:Boolean(site.shade_available),waterAvailable:Boolean(site.water_available),restArea:Boolean(site.rest_area)},weather:{...weather},now:nowDate};
    const cooldownRemaining=Math.max(0,config.cooldownMinutes-Math.min(config.cooldownMinutes,...Object.values(lastByType).map(value=>Math.max(0,(nowDate.getTime()-Date.parse(value))/60000)))),clock=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:weather.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(nowDate).map(part=>[part.type,part.value])),clockMinutes=Number(clock.hour)*60+Number(clock.minute),clockMinute=value=>{const [h,m]=String(value).split(':').map(Number);return h*60+m;},quietStart=clockMinute(config.quietHours.start),quietEnd=clockMinute(config.quietHours.end);
    context.limits={cooldownRemaining,dailyCapRemaining:Math.max(0,config.dailyCap-sentToday),quietHours:quietStart<quietEnd?clockMinutes>=quietStart&&clockMinutes<quietEnd:clockMinutes>=quietStart||clockMinutes<quietEnd};return context;
  });
}
function alertEventKey(decision,context){const weather=context.weather;if(decision.alert_type==='rain_2h')return `rain:${context.site.id}:${weather.expectedRainStart||Math.floor(now()/3600)}`;if(decision.alert_type==='lightning')return `lightning:${context.site.id}:${weather.expectedRainStart||Math.floor(now()/3600)}`;if(['heat_nudge','shade_break'].includes(decision.alert_type))return `${decision.alert_type}:${context.site.id}:${new Date().toISOString().slice(0,10)}`;return `${decision.alert_type}:${context.site.id}:${Math.floor(now()/1800)}`;}
async function dispatchAlertQueue(){
  const queued=db.prepare("SELECT a.*,w.phone,w.consent_at,w.shift_start,w.shift_end FROM automated_alerts a JOIN workers w ON w.id=a.worker_id WHERE a.status IN ('queued','scheduled') AND a.scheduled_at<=? ORDER BY a.scheduled_at LIMIT 200").all(now()),ready=[];
  for(const row of queued){if(!row.consent_at){db.prepare("UPDATE automated_alerts SET status='skipped',reason='Consent withdrawn before dispatch.' WHERE id=?").run(row.id);continue;}let timezone='Asia/Dhaka';try{timezone=JSON.parse(row.input_context).weather?.timezone||timezone;}catch{}if(!workerIsOnShift(row,new Date(),timezone)){db.prepare("UPDATE automated_alerts SET status='skipped',reason='Outside the worker shift at send time.' WHERE id=?").run(row.id);continue;}ready.push({...row,phone:normalizePhone(row.phone)});}
  const sendable=[];
  for(const row of ready){if(!row.phone)continue;let message=row.message;if(row.alert_type==='rain_2h'&&!row.floor){let eta=null;try{eta=Number(JSON.parse(row.input_context).weather?.rainEtaMinutes);}catch{}const elapsed=Math.max(0,(now()-row.created_at)/60);if(!Number.isFinite(eta)||elapsed>=eta){db.prepare("UPDATE automated_alerts SET status='skipped',reason='Rain forecast window passed before dispatch.' WHERE id=?").run(row.id);continue;}message=renderAlertTemplate('rain_2h',{minutes:Math.max(1,Math.round(eta-elapsed))});db.prepare('UPDATE automated_alerts SET message=? WHERE id=?').run(message,row.id);}sendable.push({...row,message});}
  const groups=await dispatchAlertGroups(sendable.map(row=>({id:row.id,phone:row.phone,message:row.message,channel:row.channel})),{smsSender:async entries=>{const refs=new Set(entries.flatMap(entry=>entry.referenceIds||[])),related=sendable.filter(row=>refs.has(row.id)),result=await sendTextBeeMessages(entries,entries[0]?.message||'JibonGuard safety alert',{organizationId:sendable[0]?.organization_id,siteId:sendable[0]?.site_id,feature:'ai_alert_automation',category:related.some(row=>row.floor||row.alert_type==='lightning')?'safety':'routine'});return {accepted:result.accepted};}});
  for(const group of groups)for(const item of group.items){const accepted=group.sms.accepted,status=accepted?'sent':'failed',sentAt=accepted?now():null;db.prepare('UPDATE automated_alerts SET status=?,sent_at=? WHERE id=?').run(status,sentAt,item.id);}
  for(const row of ready.filter(item=>!item.phone))db.prepare("UPDATE automated_alerts SET status='failed',reason=reason||' Worker phone number is invalid.' WHERE id=?").run(row.id);
  return groups.length;
}
let alertSchedulerRunning=false;
async function runAlertAutomationTick(){
  if(alertSchedulerRunning)return;alertSchedulerRunning=true;
  try{for(const organization of db.prepare('SELECT id FROM organizations').all()){
    const settings=alertSettingsFor(organization.id),config=runtimeAlertConfig(settings);config.organizationId=organization.id;if(!config.enabled)continue;
    const sites=db.prepare('SELECT * FROM sites WHERE organization_id=? AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY id').all(organization.id);
    for(const site of sites)try{
      const contexts=await buildAlertContexts(site,organization.id,config);if(!contexts.length)continue;
      const result=await decideAlerts(contexts,{config,getHistory:workerId=>{const row=contexts.find(item=>item.worker.id===workerId);const sent=db.prepare("SELECT alert_type,MAX(COALESCE(sent_at,scheduled_at)) AS stamp FROM automated_alerts WHERE organization_id=? AND worker_id=? AND status IN ('sent','scheduled','queued') GROUP BY alert_type").all(organization.id,workerId);return {sentToday:row?.state.alertsSentToday||0,lastByType:Object.fromEntries(sent.filter(item=>item.stamp).map(item=>[item.alert_type,new Date(item.stamp*1000).toISOString()]))};}});
      for(const decision of result.decisions){const context=contexts.find(item=>item.worker.id===decision.workerId);if(!context)continue;const eventKey=alertEventKey(decision,context),existing=db.prepare("SELECT id FROM automated_alerts WHERE organization_id=? AND worker_id=? AND event_key=? AND status IN ('sent','queued','scheduled')").get(organization.id,decision.workerId,eventKey);let status=decision.final_status==='skipped'?'skipped':decision.final_status==='scheduled'?'scheduled':'queued',reason=decision.reason;const mergeTarget=!existing&&decision.action==='merge'?db.prepare("SELECT id,message,scheduled_at FROM automated_alerts WHERE organization_id=? AND worker_id=? AND channel=? AND status IN ('queued','scheduled') ORDER BY scheduled_at LIMIT 1").get(organization.id,decision.workerId,decision.channel):null;if(existing){status='skipped';reason='Duplicate weather event already alerted.';}else if(mergeTarget){status='merged';reason='Merged with a pending template alert.';db.prepare("UPDATE automated_alerts SET message=message||char(10)||?,reason=reason||? WHERE id=?").run(decision.message,` Merged ${decision.alert_type} reminder.`,mergeTarget.id);}const scheduledAt=status==='scheduled'?Math.floor(Date.parse(decision.send_at)/1000):mergeTarget?mergeTarget.scheduled_at:now(),id=token(12),safeContext={worker:{...context.worker,phone:undefined,name:undefined},state:context.state,site:context.site,weather:context.weather,rule:context.rule,limits:context.limits};
        db.prepare('INSERT INTO automated_alerts(id,organization_id,worker_id,site_id,event_key,alert_type,channel,action,status,scheduled_at,created_at,reason,input_hash,model_output,input_context,variables,message,floor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,organization.id,decision.workerId,site.id,eventKey,decision.alert_type,decision.channel,decision.action,status,scheduledAt,now(),reason,decision.inputHash,decision.modelOutput==null?'':JSON.stringify(decision.modelOutput),JSON.stringify(safeContext),JSON.stringify(decision.variables||{}),decision.message,decision.floor?1:0);
      }
    }catch(error){console.error(`Alert automation failed for site ${site.id}: ${error.message}`);}
  }await dispatchAlertQueue();}catch(error){console.error(`Alert automation cycle failed: ${error.message}`);}finally{alertSchedulerRunning=false;}
}
jobRunner.register('alert_automation', runAlertAutomationTick, { jitterMs: 0 });
async function runAlertAutomation(){ await jobRunner.execute('alert_automation'); }
function meterSmsAttempt(entries,usageContext={},status,attemptId=token(16)){
  const {organizationId,siteId=null,category='routine',feature='sms'}=usageContext;
  if(!organizationId)return;
  const unique=new Map();for(const entry of entries){const key=`${entry.phone}\0${entry.message}`;if(!unique.has(key))unique.set(key,entry);}
  for(const entry of unique.values()){
    const sms=calculateSmsSegments(entry.message||''),refs=[...(entry.referenceIds||[]),...(entry.refId?[entry.refId]:[])].map(String).sort();
    const reference=refs.length?refs.map(ref=>usageContext.refPrefix?`${usageContext.refPrefix}:${ref}`:ref).join(','):attemptId;
    metering.recordUsage({organizationId,siteId,eventType:'sms_outbound',provider:'textbee',feature,quantity:sms.segments,unit:'segment',status,category,unitPriceMinor:['failed','blocked'].includes(status)?0:undefined,refType:refs.length?'send_attempt':'provider_attempt',refId:reference,metadata:{encoding:sms.encoding,units:sms.units,category},idempotencyKey:`sms-out:${organizationId}:${attemptId}:${reference}`});
  }
}
function smsQuotaDecision(messages,usageContext={}){
  if(!usageContext.organizationId)return {allowed:true};
  const quantity=messages.reduce((sum,item)=>sum+item.recipients.length*calculateSmsSegments(item.message||'').segments,0);
  return checkUsageDispatch(db,{organizationId:usageContext.organizationId,eventType:'sms_outbound',quantity,category:usageContext.category||'routine'});
}
async function sendTextBeeMessages(entries,messageTemplate,usageContext={}) {
  const apiKey=(process.env.TEXTBEE_API_KEY||process.env.TEXTBEE_DEV_API||'').trim();
  const base=(process.env.TEXTBEE_BASE_URL||'https://api.textbee.dev/api/v1').replace(/\/$/,'');
  const subscription=(process.env.TEXTBEE_SIM_SUBSCRIPTION_ID||process.env.SIM_SUBSCRIPTION_ID||'').trim();
  if(!apiKey||!base.startsWith('https://')||!entries.length)return {accepted:false};
  const attemptId=token(16),started=Date.now();
  const byText=new Map();for(const entry of entries){if(!byText.has(entry.message))byText.set(entry.message,new Set());byText.get(entry.message).add(entry.phone);}
  const messages=[...byText].map(([message,phones])=>({recipients:[...phones],message,...(subscription&&/^\d+$/.test(subscription)?{simSubscriptionId:Number(subscription)}:{})}));
  const quota=smsQuotaDecision(messages,usageContext);if(!quota.allowed){meterSmsAttempt(entries,usageContext,'blocked',attemptId);return {accepted:false,blocked:true,reason:quota.reason||'quota'};}
  try {
    const response=await fetch(`${base}/gateway/send-bulk-sms`,{method:'POST',signal:AbortSignal.timeout(20000),headers:{'x-api-key':apiKey,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({messages,messageTemplate})});
    const result=await response.json().catch(()=>({}));
    const accepted=response.ok&&(result.data?.success===true||Number(result.data?.successCount)>0||Number(result.data?.recipientCount)>0);
    meterSmsAttempt(entries,usageContext,accepted?'queued':'failed',attemptId);
    return {accepted,result,latencyMs:Date.now()-started};
  } catch { meterSmsAttempt(entries,usageContext,'failed',attemptId);return {accepted:false}; }
}
const EMERGENCY_MANUAL='বিপদে শুধু সংখ্যা লিখে পাঠান: ১ দুর্ঘটনা/সাহায্য, ২ আগুন, ৩ গরমে অসুস্থ, ৪ সহকর্মী অজ্ঞান/গুরুতর অসুস্থ, ৫ বিদ্যুৎ বিপদ, ৬ পড়ে যাওয়া/ধস, ৭ ঝড়/বজ্রপাত, ৮ গ্যাস লিক/বিষাক্ত ধোঁয়া, ৯ অন্য জরুরি সমস্যা। ০ লিখলে এই নির্দেশিকা পাবেন। জীবন বিপন্ন হলে ৯৯৯ এ কল করুন।';
const FORMATTED_EMERGENCY_MANUAL=[
  'জরুরি সংকেত:',
  '১ — দুর্ঘটনা / সাহায্য',
  '২ — আগুন',
  '৩ — গরমে অসুস্থতা',
  '৪ — সহকর্মী অজ্ঞান বা গুরুতর অসুস্থ',
  '৫ — বিদ্যুতের বিপদ',
  '৬ — উঁচু থেকে পড়ে যাওয়া / ধস',
  '৭ — ঝড় / বজ্রপাতের বিপদ',
  '৮ — গ্যাস লিক / বিষাক্ত ধোঁয়া',
  '৯ — অন্য জরুরি সমস্যা',
  '০ — এই নির্দেশিকা',
  '',
  'বিপদে শুধু সংখ্যা লিখে পাঠান। জীবন বিপন্ন হলে ৯৯৯ এ কল করুন।'
].join('\n');
EMERGENCY_CODES['0'].reply=`জীবনগার্ড নির্দেশিকা:\n${FORMATTED_EMERGENCY_MANUAL}`;
function workerWelcomeText(worker) {
  return `জীবনগার্ড: ${worker.name}, আপনার নিবন্ধন সম্পন্ন হয়েছে।\nজরুরি বার্তার নির্দেশিকা:\n${FORMATTED_EMERGENCY_MANUAL}`;
}
async function sendWorkerWelcomeMessages(workers, organizationId) {
  if(!(process.env.TEXTBEE_API_KEY||process.env.TEXTBEE_DEV_API||'').trim())return {status:'not_configured',recipient_count:0};
  const entries=[];
  for(const worker of workers){const timezone=worker.siteId?await timezoneForSite(worker.siteId,organizationId):'Asia/Dhaka';if(workerIsOnShift(worker,new Date(),timezone)){const phone=normalizePhone(worker.phone);if(phone)entries.push({phone,message:workerWelcomeText(worker),refId:worker.id});}}
  let accepted=0;
  for(let start=0;start<entries.length;start+=50){const result=await sendTextBeeMessages(entries.slice(start,start+50),'জীবনগার্ড কর্মী নিবন্ধন',{organizationId,feature:'worker_registration',category:'routine'});if(result.accepted)accepted+=entries.slice(start,start+50).length;}
  return {status:accepted===entries.length&&entries.length?'queued':accepted?'partial':entries.length?'failed':'outside_shift',recipient_count:accepted,skipped_outside_shift:workers.length-entries.length};
}
async function sendWorkerWelcomeSms(worker, organizationId) { return sendWorkerWelcomeMessages([worker],organizationId); }
async function syncEmergencySms({seed=false}={}) {
  const apiKey=(process.env.TEXTBEE_API_KEY||process.env.TEXTBEE_DEV_API||'').trim();
  if(!apiKey)return {configured:false,received:0};
  const base=(process.env.TEXTBEE_BASE_URL||'https://api.textbee.dev/api/v1').replace(/\/$/,'');
  if(!base.startsWith('https://'))return {configured:true,received:0};
  const response=await fetch(`${base}/gateway/messages?direction=received&order=desc&limit=100`,{signal:AbortSignal.timeout(15000),headers:{'x-api-key':apiKey,Accept:'application/json','User-Agent':'JibonGuard/1.0 (emergency SMS monitor)'}});
  if(!response.ok)throw new Error(`TextBee returned HTTP ${response.status}`);
  const result=await response.json(),incoming=Array.isArray(result.data)?result.data:[];
  const workers=db.prepare('SELECT id,organization_id,name,phone,site,site_id FROM workers').all();
  const byPhone=new Map();
  for(const worker of workers)for(const key of smsPhoneKeys(worker.phone)){if(!byPhone.has(key))byPhone.set(key,[]);byPhone.get(key).push(worker);}
  const insert=db.prepare(`INSERT INTO sms_messages(id,organization_id,direction,sender,recipient,message,status,device_name,message_at,created_at,emergency_status) VALUES(?,?,'received',?,'',?,?,?,?,?,'') ON CONFLICT(organization_id,id) DO NOTHING`);
  const claim=db.prepare("UPDATE sms_messages SET emergency_status='processing' WHERE organization_id=? AND id=? AND emergency_status=''");
  let handled=0;
  for(const item of incoming){
    const id=String(item._id||'');if(!id)continue;
    const sender=String(item.sender||''),matches=[...new Set(smsPhoneKeys(sender).flatMap(key=>byPhone.get(key)||[]))];
    if(!matches.length)continue;
    const orgs=new Map();for(const worker of matches){if(!orgs.has(worker.organization_id))orgs.set(worker.organization_id,[]);orgs.get(worker.organization_id).push(worker);}
    for(const [orgId,orgMatches] of orgs){
      const stamp=item.receivedAt||item.createdAt||new Date().toISOString();
      const inserted=insert.run(id,orgId,sender,String(item.message||''),String(item.status||'received'),String(item.device?.name||''),stamp,now());
      if(inserted.changes){const content=String(item.message||''),emergency=Boolean(emergencySmsCode(content));metering.recordUsage({organizationId:orgId,eventType:'sms_inbound',provider:'textbee',feature:emergency?'emergency_code':'inbound',quantity:1,unit:'message',status:String(item.status||'received'),category:emergency?'emergency':'routine',metadata:{segments:calculateSmsSegments(content).segments},refType:'provider_message',refId:id,idempotencyKey:`sms-in:${orgId}:${id}`});}
      if(seed&&Date.now()-Date.parse(item.createdAt||stamp)>120000){db.prepare("UPDATE sms_messages SET emergency_status='historic' WHERE organization_id=? AND id=? AND emergency_status=''").run(orgId,id);continue;}
      if(seed)db.prepare("UPDATE sms_messages SET emergency_status='' WHERE organization_id=? AND id=? AND emergency_status='historic'").run(orgId,id);
      const code=emergencySmsCode(item.message);if(!code)continue;
      if(claim.run(orgId,id).changes!==1)continue;
      try{
        const senderWorker=orgMatches[0],siteId=senderWorker.site_id;
        if(code==='0'){
          const sent=await sendTextBeeMessages([{phone:normalizePhone(sender)||normalizePhone(orgMatches[0].phone),message:EMERGENCY_CODES[code].reply,refId:`${id}:reply`}],'জরুরি নির্দেশিকা',{organizationId:orgId,siteId,feature:'emergency_code',category:'emergency'});
          db.prepare('UPDATE sms_messages SET emergency_status=? WHERE organization_id=? AND id=?').run(sent.accepted?'queued':'failed',orgId,id);handled++;continue;
        }
        const siteWorkers=db.prepare('SELECT name,phone FROM workers WHERE organization_id=? AND site_id=?').all(orgId,siteId);
        const recipients=[...new Map(siteWorkers.map(worker=>[normalizePhone(worker.phone),{phone:normalizePhone(worker.phone),name:worker.name,refId:`${id}:${worker.id}`}]).filter(([phone])=>phone)).values()];
        const sendersPhone=normalizePhone(sender);
        const bengaliCode=code.replace(/[0-9]/g,digit=>BANGLA_DIGITS[Number(digit)]);
        const broadcast=`জরুরি সতর্কতা: ${senderWorker.name} ${senderWorker.site} কর্মস্থল থেকে ${bengaliCode} নম্বরের বার্তা দিয়েছেন (${EMERGENCY_CODES[code].label})। ${EMERGENCY_CODES[code].reply} জীবন বিপন্ন হলে ৯৯৯ এ কল করুন।`;
        const batch=[{phone:sendersPhone||normalizePhone(senderWorker.phone),message:EMERGENCY_CODES[code].reply,refId:`${id}:reply`},...recipients.map(worker=>({phone:worker.phone,message:broadcast,refId:worker.refId}))];
        const sent=await sendTextBeeMessages(batch,'জীবনগার্ড জরুরি সতর্কতা',{organizationId:orgId,siteId,feature:'emergency_code',category:'emergency'});
        db.prepare('UPDATE sms_messages SET emergency_status=? WHERE organization_id=? AND id=?').run(sent.accepted?'queued':'failed',orgId,id);handled++;
      }catch(error){db.prepare("UPDATE sms_messages SET emergency_status='failed' WHERE organization_id=? AND id=?").run(orgId,id);console.error(`Emergency SMS processing failed (${error.name})`);}
    }
  }
  if(seed)db.prepare("INSERT INTO sms_sync_state(key,value) VALUES('emergency_seeded','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  return {configured:true,received:incoming.length,handled};
}
let emergencySmsPollRunning=false;
async function pollEmergencySms() {
  if(emergencySmsPollRunning)return;
  emergencySmsPollRunning=true;
  try{
    const seeded=db.prepare("SELECT value FROM sms_sync_state WHERE key='emergency_seeded'").get();
    await syncEmergencySms({seed:!seeded});
  }catch(error){console.error(`Emergency SMS poll failed (${error.name})`);}
  finally{emergencySmsPollRunning=false;}
}
const WORKLOAD_LEVELS=['Light','Standard','Heavy'];
function normalizeWorkloadLevels(value) {
  if(value===undefined)return [...WORKLOAD_LEVELS];
  if(!Array.isArray(value)||!value.length||value.some(level=>!WORKLOAD_LEVELS.includes(level)))return null;
  return [...new Set(value)];
}
function consentedRecipients(org, siteId) {
  const rows=db.prepare('SELECT id AS worker_id,name,phone,workload,shift_start,shift_end FROM workers WHERE organization_id=? AND site_id=? AND consent_at IS NOT NULL').all(org,siteId);
  return rows.map(row=>({...row,phone:normalizePhone(row.phone)})).filter(row=>row.phone);
}
app.post('/api/breaks',csrfAndOrigin,requireUser,async(req,res)=>{
  const d=req.body, alertType=String(d.alert_type||'break').trim(), title=BREAK_ALERTS[alertType]||String(d.title||'').trim(), siteId=String(d.site_id||'').trim(), date=String(d.break_date||'').trim(), time=String(d.break_time||'').trim(), status=String(d.status||'logged').trim(), duration=Number(d.duration_minutes),workloadLevels=normalizeWorkloadLevels(d.workload_levels);
  if(!workloadLevels)return sendError(res,400,'Choose at least one valid workload level for the safety message.');
  if (!['break','rain','storm','earthquake'].includes(alertType)||!title||title.length>120||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isInteger(duration)||duration<1||duration>240||!['logged','scheduled'].includes(status)) return sendError(res,400,'Enter a break name, site, valid date and time, and duration from 1 to 240 minutes.');
  const [year,month,day]=date.split('-').map(Number),validDate=new Date(Date.UTC(year,month-1,day));
  if(validDate.getUTCFullYear()!==year||validDate.getUTCMonth()!==month-1||validDate.getUTCDate()!==day)return sendError(res,400,'Enter a valid break date.');
  const site=db.prepare('SELECT id,name,latitude,longitude FROM sites WHERE id=? AND organization_id=?').get(siteId,req.user.organization_id);
  if (!site) return sendError(res,400,'Choose a worksite from your saved Sites list.');
  const siteConsented=consentedRecipients(req.user.organization_id,siteId),consented=siteConsented.filter(worker=>workloadLevels.includes(worker.workload));
  const timezone=status==='logged'?await timezoneForSite(siteId,req.user.organization_id):null;
  const inShift=status==='logged'?consented.filter(worker=>workerIsOnShift(worker,new Date(),timezone)):consented;
  const recipients=[...new Map(inShift.map(worker=>[worker.phone,{...worker,refId:worker.id}])).values()];
  const workerCount=db.prepare('SELECT COUNT(*) AS count FROM workers WHERE organization_id=?').get(req.user.organization_id).count,id=token(12),stamp=now();
  const parsedSchedule=Number(d.scheduled_at), scheduledAt=Number.isFinite(parsedSchedule)&&parsedSchedule>0?Math.floor(parsedSchedule):Math.floor(new Date(`${date}T${time}:00`).getTime()/1000);
  if(!Number.isFinite(scheduledAt)||scheduledAt<=now())return sendError(res,400,'Choose a date and time later than the current time.');
  db.prepare(`INSERT INTO break_logs(id,organization_id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at,workload_levels)
    VALUES(?,?,?,?,?,?,?,?,?,'manual',?,'',?,?)`).run(id,req.user.organization_id,title,site.name,date,time,duration,workerCount,status,alertType,stamp,JSON.stringify(workloadLevels));
  const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=?').get(id);
  if(status==='scheduled'){
    const count=queueBreakSms(req.user.organization_id,id,recipients,{...record,scheduled_at:scheduledAt},scheduledAt);
    return res.status(201).json({break:record,sms:{status:'scheduled',recipient_count:count,message:count?`SMS queued for ${date} at ${time} for selected workload levels.`:'Safety log scheduled; no consented workers in the selected workload levels are assigned to this site.'}});
  }
  const sms=await sendTextBeeBreakSms(recipients,{...record,scheduled_at:scheduledAt},{organizationId:req.user.organization_id,siteId:site.id,refPrefix:id,feature:alertType==='break'?'break_reminder':'safety_alert',category:alertType==='break'?'routine':'safety'});
  if(siteConsented.length&&!consented.length)sms.message='Break saved, but no consented worker at this site matches the selected workload levels.';
  else if(consented.length&&!recipients.length)sms.message='Break saved, but no selected worker is currently within their shift; no SMS was sent.';
  res.status(201).json({break:record,sms});
});
app.put('/api/breaks',csrfAndOrigin,requireUser,async(req,res)=>{
  const id=String(req.query.id||'').trim();
  if(!id)return sendError(res,400,'Choose a break log to update.');
  const existing=db.prepare('SELECT id,source,status FROM break_logs WHERE id=? AND organization_id=?').get(id,req.user.organization_id);
  if(!existing)return sendError(res,404,'Break log not found.');
  if(existing.source!=='manual')return sendError(res,403,'AI-created safety logs are read-only.');
  const d=req.body,alertType=String(d.alert_type||'break').trim(),title=BREAK_ALERTS[alertType]||String(d.title||'').trim(),siteId=String(d.site_id||'').trim(),date=String(d.break_date||'').trim(),time=String(d.break_time||'').trim(),status=String(d.status||'logged').trim(),duration=Number(d.duration_minutes),workloadLevels=normalizeWorkloadLevels(d.workload_levels);
  if(!workloadLevels)return sendError(res,400,'Choose at least one valid workload level for the safety message.');
  if(!['break','rain','storm','earthquake'].includes(alertType)||!title||title.length>120||!/^(\d{4})-(\d{2})-(\d{2})$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isInteger(duration)||duration<1||duration>240||!['logged','scheduled'].includes(status))return sendError(res,400,'Enter a valid action, worksite, date, time, and duration from 1 to 240 minutes.');
  const [year,month,day]=date.split('-').map(Number),validDate=new Date(Date.UTC(year,month-1,day));
  if(validDate.getUTCFullYear()!==year||validDate.getUTCMonth()!==month-1||validDate.getUTCDate()!==day)return sendError(res,400,'Enter a valid break date.');
  const site=db.prepare('SELECT id,name,latitude,longitude FROM sites WHERE id=? AND organization_id=?').get(siteId,req.user.organization_id);
  if(!site)return sendError(res,400,'Choose a worksite from your saved Sites list.');
  const parsedSchedule=Number(d.scheduled_at),scheduledAt=Number.isFinite(parsedSchedule)&&parsedSchedule>0?Math.floor(parsedSchedule):Math.floor(new Date(`${date}T${time}:00`).getTime()/1000);
  if(!Number.isFinite(scheduledAt)||scheduledAt<=now())return sendError(res,400,'Choose a date and time later than the current time.');
  const workerCount=db.prepare('SELECT COUNT(*) AS count FROM workers WHERE organization_id=?').get(req.user.organization_id).count;
  db.prepare('UPDATE break_logs SET title=?,site=?,break_date=?,break_time=?,duration_minutes=?,worker_count=?,status=?,alert_type=?,workload_levels=? WHERE id=? AND organization_id=? AND source=\'manual\'').run(title,site.name,date,time,duration,workerCount,status,alertType,JSON.stringify(workloadLevels),id,req.user.organization_id);
  const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,workload_levels,created_at FROM break_logs WHERE id=? AND organization_id=?').get(id,req.user.organization_id);
  if(existing.status==='scheduled'||status==='scheduled'){
    db.prepare("DELETE FROM scheduled_break_sms WHERE break_id=? AND organization_id=? AND status='scheduled'").run(id,req.user.organization_id);
    if(status==='scheduled'){
      const siteRow=db.prepare('SELECT id FROM sites WHERE id=? AND organization_id=?').get(siteId,req.user.organization_id);
      const count=queueBreakSms(req.user.organization_id,id,consentedRecipients(req.user.organization_id,siteRow.id).filter(worker=>workloadLevels.includes(worker.workload)),{...record,scheduled_at:scheduledAt},scheduledAt);
      return res.json({break:record,sms:{status:'scheduled',recipient_count:count,message:`SMS queue updated for ${date} at ${time} for selected workload levels.`}});
    }
  }
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
      const weather=await openMeteo(site,1,req.user.organization_id),current=weather.current,hourly=weather.hourly||{},forecast=(hourly.time||[]).slice(0,24).filter((_,i)=>i%2===0).map((time,i)=>({time,temperature_c:(hourly.temperature_2m||[])[i*2],feels_like_c:(hourly.apparent_temperature||[])[i*2],rain_probability_percent:(hourly.precipitation_probability||[])[i*2],weather_code:(hourly.weather_code||[])[i*2],wind_speed_m_s:(hourly.wind_speed_10m||[])[i*2]}));
      const context={site:site.name,address:site.address,timezone:weather.timezone||'UTC',current:{temperature_2m:current.temperature_2m,apparent_temperature:current.apparent_temperature,relative_humidity_2m:current.relative_humidity_2m,precipitation:current.precipitation,weather_code:current.weather_code,wind_speed_10m:current.wind_speed_10m,wind_gusts_10m:current.wind_gusts_10m},next_hours:forecast};
      const instruction='Recommend at most one safety log using only supplied Open-Meteo data. Return JSON with action (schedule or no_schedule), alert_type (break, rain, or storm), duration_minutes (10, 15, or 20), rationale (under 35 words). Use storm for thunderstorms or dangerous wind, rain for substantial rain risk, and a routine water/shade break for dangerous heat. Choose no_schedule only when no safety action is warranted. Never invent observations.';
      const decision=JSON.parse(await geminiGenerate([{role:'user',parts:[{text:JSON.stringify(context)}]}],instruction,true,{organizationId:req.user.organization_id,feature:'break_suggestion'}));
      const code=Number(current.weather_code),gusts=Number(current.wind_gusts_10m),apparent=Number(current.apparent_temperature),maxRain=Math.max(0,...forecast.map(item=>Number(item.rain_probability_percent)||0));
      if([95,96,99].includes(code)||gusts>=20)Object.assign(decision,{action:'schedule',alert_type:'storm'});else if(maxRain>=70)Object.assign(decision,{action:'schedule',alert_type:'rain'});else if(apparent>=35)Object.assign(decision,{action:'schedule',alert_type:'break'});
      if(decision.action!=='schedule'||!['break','rain','storm'].includes(decision.alert_type))continue;
      const stamp=String(current.time||new Date().toISOString()).slice(0,16),localClock=new Date(`${stamp}:00Z`),scheduled=new Date(localClock);scheduled.setUTCMinutes(0,0,0);if(scheduled<=new Date(localClock.getTime()+1200000))scheduled.setUTCHours(scheduled.getUTCHours()+1);while(scheduled.getUTCHours()%2)scheduled.setUTCHours(scheduled.getUTCHours()+1);
      pending.push({site,title:BREAK_ALERTS[decision.alert_type],alert_type:decision.alert_type,duration:[10,15,20].includes(Number(decision.duration_minutes))?Number(decision.duration_minutes):15,rationale:String(decision.rationale||'Weather safety break recommended.').replace(/\s+/g,' ').slice(0,300),date:scheduled.toISOString().slice(0,10),time:`${String(scheduled.getUTCHours()).padStart(2,'0')}:${String(scheduled.getUTCMinutes()).padStart(2,'0')}`});
    }catch(error){console.error(`AI schedule skipped ${site.id}: ${error.name}`);errors.push(error.message);}
  }
  if (!pending.length) { if(errors.length)return sendError(res,502,errors[0]); return res.json({created:[],message:'AI found no suitable weather-based break to schedule, or weather/Gemini was unavailable.'}); }
  const created=[],sms=[];let already=0,workerCount=db.prepare('SELECT COUNT(*) AS count FROM workers WHERE organization_id=?').get(req.user.organization_id).count;
  for(const item of pending){const duplicate=db.prepare("SELECT 1 FROM break_logs WHERE organization_id=? AND site=? AND break_date=? AND break_time=? AND source='ai' LIMIT 1").get(req.user.organization_id,item.site.name,item.date,item.time);if(duplicate){already++;continue;}const id=token(12);db.prepare(`INSERT INTO break_logs(id,organization_id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at) VALUES(?,?,?,?,?,?,?,?, 'scheduled','ai',?,?,?)`).run(id,req.user.organization_id,item.title,item.site.name,item.date,item.time,item.duration,workerCount,item.alert_type,item.rationale,now());const record=db.prepare('SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=?').get(id);created.push(record);const at=Math.floor(new Date(`${item.date}T${item.time}:00Z`).getTime()/1000),count=queueBreakSms(req.user.organization_id,id,consentedRecipients(req.user.organization_id,item.site.id),{...record,scheduled_at:at},at);sms.push({status:'scheduled',recipient_count:count});}
  const suffix=already?` ${already} matching AI log(s) already existed.`:'';
  res.status(201).json({created,sms,message:`AI scheduled ${created.length} weather-based break log(s); worker messages are queued for their break times.${suffix}`});
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
if (!process.env.VERCEL) {
app.listen(PORT, HOST, () => {
  console.log(`JibonGuard Node server listening at http://${HOST}:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`);
  const firstPoll=setTimeout(()=>void pollEmergencySms(),2000);firstPoll.unref();
  const emergencyPoll=setInterval(()=>void pollEmergencySms(),30000);emergencyPoll.unref();
  const alertFirstRun=setTimeout(()=>void runAlertAutomation(),5000);alertFirstRun.unref();
  const alertPoll=setInterval(()=>void runAlertAutomation(),ALERT_CONFIG.intervalMs);alertPoll.unref();
  const breakSmsFirstRun=setTimeout(()=>void dispatchScheduledBreakSms(),3000);breakSmsFirstRun.unref();
  const breakSmsPoll=setInterval(()=>void dispatchScheduledBreakSms(),15000);breakSmsPoll.unref();
  const rollupFirstRun=setTimeout(()=>void jobRunner.execute('usage_rollups'),8000);rollupFirstRun.unref();
  const rollupPoll=setInterval(()=>void jobRunner.execute('usage_rollups'),USAGE_ROLLUP_INTERVAL_MS);rollupPoll.unref();
  const billingFirstRun=setTimeout(()=>void jobRunner.execute('billing_lifecycle'),12000);billingFirstRun.unref();
  const billingPoll=setInterval(()=>void jobRunner.execute('billing_lifecycle'),BILLING_LIFECYCLE_INTERVAL_MS);billingPoll.unref();
});
}

export default app;
