/**
 * Encryption for Stripe Connect OAuth tokens.
 *
 * Uses AES-256-GCM with a key derived from CONNECT_TOKEN_ENCRYPTION_KEY
 * (falling back to JWT_SECRET for local dev convenience). Payloads are stored
 * as base64 strings of the form: IV (12 bytes) || ciphertext || auth tag (16 bytes).
 *
 * Kept separate from utils/crypto.ts so the Connect token key can be rotated
 * independently of password encryption and so these helpers do not wrap
 * tokens in a JWT (we just want reversible encryption, not a signed payload).
 */
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function getKeyMaterial(): string {
  const key = process.env.CONNECT_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!key) {
    throw new Error(
      'CONNECT_TOKEN_ENCRYPTION_KEY (or JWT_SECRET fallback) must be set to encrypt Stripe Connect tokens.'
    );
  }
  return key;
}

function deriveKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(Buffer.from(secret, 'utf8'), 'stripe-connect-salt', 100000, KEY_LEN, 'sha256');
}

export function encryptConnectToken(plaintext: string): string {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('encryptConnectToken: plaintext must be a non-empty string');
  }
  const key = deriveKey(getKeyMaterial());
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

export function decryptConnectToken(encoded: string): string {
  if (!encoded || typeof encoded !== 'string') {
    throw new Error('decryptConnectToken: encoded must be a non-empty string');
  }
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('decryptConnectToken: payload too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const key = deriveKey(getKeyMaterial());
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Best-effort redactor for logs. Never log raw tokens.
 */
export function redactToken(token?: string | null): string {
  if (!token) return '<empty>';
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
