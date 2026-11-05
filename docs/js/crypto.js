// Optional passphrase encryption of the Drive file (Web Crypto API).
// PBKDF2-SHA256 derives an AES-256-GCM key from the passphrase + random salt.
// The passphrase itself is never stored or uploaded. If it is lost, the
// encrypted Drive file cannot be decrypted by anyone — including us.
import { APP_ID, FILE_FORMAT, PBKDF2_ITERATIONS } from './constants.js';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomSalt() {
  return b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** Derive a non-extractable AES-GCM key. Returns { key, salt, iterations }. */
export async function deriveKey(passphrase, salt = randomSalt(), iterations = PBKDF2_ITERATIONS) {
  const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  return { key, salt, iterations };
}

/** Wrap register data into the Drive file envelope (encrypted or plain). */
export async function seal(regs, keyInfo) {
  const savedAt = new Date().toISOString();
  if (!keyInfo) return JSON.stringify({ app: APP_ID, format: FILE_FORMAT, encrypted: false, savedAt, regs });
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, keyInfo.key, enc.encode(JSON.stringify(regs)));
  return JSON.stringify({
    app: APP_ID, format: FILE_FORMAT, encrypted: true, savedAt,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: keyInfo.iterations, salt: keyInfo.salt },
    cipher: { name: 'AES-GCM', iv: b64(iv) },
    data: b64(ct),
  });
}

export class NeedsPassphrase extends Error {
  constructor(kdf, wrong = false) {
    super(wrong ? 'The passphrase did not match the Drive file.' : 'The Drive file is encrypted — enter the passphrase.');
    this.kdf = kdf;
    this.wrong = wrong;
  }
}

/** Parse a Drive file. Returns { regs, encrypted, kdf }. */
export async function open(text, keyInfo) {
  const env = JSON.parse(text);
  if (!env || env.app !== APP_ID) throw new Error('The Drive file does not belong to this app.');
  if (!env.encrypted) return { regs: env.regs || {}, encrypted: false };
  if (!keyInfo || keyInfo.salt !== env.kdf.salt || keyInfo.iterations !== env.kdf.iterations) throw new NeedsPassphrase(env.kdf);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.cipher.iv) }, keyInfo.key, unb64(env.data));
    return { regs: JSON.parse(dec.decode(pt)), encrypted: true, kdf: env.kdf };
  } catch {
    throw new NeedsPassphrase(env.kdf, true);
  }
}

export function peekKdf(text) {
  try {
    const env = JSON.parse(text);
    return env && env.encrypted ? env.kdf : null;
  } catch { return null; }
}
