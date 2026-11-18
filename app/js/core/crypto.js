// Optional client-side encryption: PBKDF2-SHA256 -> AES-GCM-256. Works in browsers and Node >= 20.
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERATIONS = 250000;

export function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const utf8ToB64 = (str) => bytesToB64(enc.encode(str));
export const b64ToUtf8 = (b64) => dec.decode(b64ToBytes(b64));

async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export const isEncrypted = (obj) => !!(obj && obj.encrypted === true && obj.data && obj.iv && obj.salt);

export async function encryptJson(obj, passphrase) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { encrypted: true, v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(ct) };
}

export async function decryptJson(wrapper, passphrase) {
  const key = await deriveKey(passphrase, b64ToBytes(wrapper.salt), wrapper.iterations || ITERATIONS);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64ToBytes(wrapper.iv) }, key, b64ToBytes(wrapper.data));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error('密碼錯誤，無法解密帳本');
  }
}
