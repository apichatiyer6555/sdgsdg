import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PREFIX = 'v1:';

// AES-256-GCM envelope: v1:<base64(iv[12] | tag[16] | ciphertext)>
export function createVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('vault key must be 32 bytes');
  return {
    encrypt(plain) {
      if (plain === null || plain === undefined || plain === '') return null;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decrypt(token) {
      if (!token) return '';
      if (!String(token).startsWith(PREFIX)) throw new Error('unsupported ciphertext format');
      const raw = Buffer.from(String(token).slice(PREFIX.length), 'base64');
      if (raw.length < 29) throw new Error('ciphertext too short');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLen: 32, maxmem: 96 * 1024 * 1024 };

const scryptAsync = (password, salt, opts) => new Promise((resolve, reject) => {
  scrypt(password, salt, opts.keyLen, { N: opts.N, r: opts.r, p: opts.p, maxmem: opts.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
});

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(String(password), Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p), keyLen: expected.length, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Human-friendly one-time password (no look-alike characters).
export function generatePassword(length = 18) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
