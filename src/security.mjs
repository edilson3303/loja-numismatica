import crypto from 'node:crypto';
import argon2 from 'argon2';

export const now = () => Date.now();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const constantEq = (a, b) => {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32
  });
}
export async function verifyPassword(hash, password) {
  try { return await argon2.verify(hash, password); } catch { return false; }
}

export function validatePassword(p) {
  const errors = [];
  if (typeof p !== 'string' || p.length < 14) errors.push('mínimo de 14 caracteres');
  if (!/[A-Z]/.test(p)) errors.push('uma letra maiúscula');
  if (!/[a-z]/.test(p)) errors.push('uma letra minúscula');
  if (!/\d/.test(p)) errors.push('um número');
  if (!/[^A-Za-z0-9]/.test(p)) errors.push('um símbolo');
  if (p.length > 128) errors.push('máximo de 128 caracteres');
  return errors;
}

function keyFromEnv() {
  const raw = process.env.APP_ENCRYPTION_KEY || '';
  const key = Buffer.from(raw, 'base64url');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY deve conter 32 bytes em base64url.');
  return key;
}
export function encryptSecret(plain) {
  const key = keyFromEnv(); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}
export function decryptSecret(blob) {
  const buf = Buffer.from(blob, 'base64url');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromEnv(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str).replace(/=+$/,'').toUpperCase().replace(/[^A-Z2-7]/g,'');
  let bits = 0, value = 0; const out=[];
  for (const ch of s) {
    const idx=B32.indexOf(ch); if(idx<0) continue;
    value=(value<<5)|idx; bits+=5;
    if(bits>=8){ out.push((value >>> (bits-8)) & 255); bits-=8; }
  }
  return Buffer.from(out);
}
export function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
export function totp(secret, time = Date.now(), step = 30) {
  const counter = Math.floor(time / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length-1] & 0x0f;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6,'0');
  return code;
}
export function verifyTotp(secret, code, window = 1) {
  const c = String(code || '').replace(/\D/g,'');
  if (c.length !== 6) return false;
  for (let i=-window;i<=window;i++) if (constantEq(totp(secret, Date.now()+i*30000), c)) return true;
  return false;
}
export function otpauthUri(secret, email, issuer='Loja numismática') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function cleanText(v, max=500) {
  return String(v ?? '').replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
export function cleanMultiline(v, max=4000) {
  return String(v ?? '').replace(/\u0000/g,'').trim().slice(0,max);
}
export function moneyToCents(v) {
  if (Number.isInteger(v)) return Math.max(0, v);
  const n = Number(String(v).replace(/[^0-9,.-]/g,'').replace(/\./g,'').replace(',','.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n*100)) : 0;
}
export function safeInt(v, min=0, max=1_000_000) {
  const n = Number.parseInt(v,10); return Number.isFinite(n) ? Math.min(max, Math.max(min,n)) : min;
}
