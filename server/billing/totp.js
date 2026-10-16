import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(value) {
  const input = String(value).toUpperCase().replace(/=+$/,'');
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const char of input) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new TypeError('Invalid base32 value.');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}

function base32Encode(bytes) {
  let bits = 0, buffer = 0, output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; output += ALPHABET[(buffer >>> bits) & 31]; }
  }
  if (bits) output += ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function newTotpSecret() { return base32Encode(randomBytes(20)); }

export function totpCode(secret, timeMs = Date.now(), stepSeconds = 30, digits = 6) {
  const counter = BigInt(Math.floor(timeMs / 1000 / stepSeconds));
  const data = Buffer.alloc(8); data.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', base32Decode(secret)).update(data).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(secret, code, timeMs = Date.now(), window = 1) {
  if (!/^\d{6}$/.test(String(code)) || !Number.isInteger(window) || window < 0 || window > 5) return false;
  const supplied = Buffer.from(String(code));
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(totpCode(secret, timeMs + offset * 30000));
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return true;
  }
  return false;
}

export function encryptTotpSecret(secret, encryptionSecret) {
  if (!encryptionSecret || String(encryptionSecret).length < 32) throw new Error('ADMIN_ENCRYPTION_KEY must contain at least 32 characters.');
  const key = scryptSync(String(encryptionSecret), 'JibonGuard admin TOTP v1', 32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}

export function decryptTotpSecret(value, encryptionSecret) {
  if (!encryptionSecret || String(encryptionSecret).length < 32) throw new Error('ADMIN_ENCRYPTION_KEY must contain at least 32 characters.');
  const [ivText, tagText, encryptedText] = String(value).split('.');
  if (!ivText || !tagText || !encryptedText) throw new TypeError('Invalid encrypted TOTP secret.');
  const key = scryptSync(String(encryptionSecret), 'JibonGuard admin TOTP v1', 32), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}
