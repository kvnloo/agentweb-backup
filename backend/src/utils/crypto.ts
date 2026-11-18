/**
 * Crypto utility functions for password encryption/decryption
 * These are separated from routes to avoid Express dependencies in worker processes
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';

// Function to derive a 32-byte key from JWT_SECRET
function deriveKey(secret: string): Buffer {
  // Convert JWT_SECRET to Buffer if it's not already
  const secretBuffer = Buffer.from(secret, 'utf8');
  return crypto.pbkdf2Sync(secretBuffer, 'salt', 100000, 32, 'sha256');
}

export function encryptPassword(password: string, userId: string): string {
  // First sign the password with userId
  const signedPassword = jwt.sign({ password, userId }, getJwtSecret());

  // Generate a random IV
  const iv = crypto.randomBytes(16);

  // Derive a 32-byte key from JWT_SECRET
  const key = deriveKey(getJwtSecret());
  
  // Create cipher using derived key
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt the signed password
  let encrypted = cipher.update(signedPassword, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Get the auth tag
  const authTag = cipher.getAuthTag();
  
  // Combine IV, encrypted data, and auth tag
  const combined = Buffer.concat([iv, Buffer.from(encrypted, 'hex'), authTag]);
  
  // Return as base64 string
  return combined.toString('base64');
}

// ENG-3119 (ENG-1757.2): versioned ciphertext keyed by CREDENTIAL_KEK, not JWT_SECRET.
// Format: "v2:" + base64(iv[12] | ciphertext | authTag[16]), AES-256-GCM over
// JSON {password, userId}. Read path only: encryptPassword still writes the
// legacy unprefixed format. Legacy base64 never contains ':', so a prefix is
// unambiguous. Turning on v2 writes is ENG-1757 (data-plane gated).
export const CREDENTIAL_CIPHERTEXT_V2_PREFIX = 'v2:';
const VERSION_PREFIX_RE = /^([A-Za-z0-9_-]+):/;

function getCredentialKek(): Buffer {
  const raw = process.env.CREDENTIAL_KEK;
  if (!raw || !raw.trim()) {
    throw new Error('CREDENTIAL_KEK is not set; cannot decrypt v2 credential ciphertext');
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_KEK must be base64 for exactly 32 bytes');
  }
  return key;
}

/**
 * Produces the v2 format. Not called by any production write path yet
 * (ENG-1757 owns that switch); exported for tests and the future cutover.
 */
export function encryptPasswordV2(password: string, userId: string): string {
  const key = getCredentialKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ password, userId }), 'utf8'),
    cipher.final(),
  ]);
  const combined = Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
  return CREDENTIAL_CIPHERTEXT_V2_PREFIX + combined.toString('base64');
}

function decryptPasswordV2(body: string): { password: string, userId: string } {
  const key = getCredentialKek();
  let decoded: { password?: unknown, userId?: unknown };
  try {
    const buffer = Buffer.from(body, 'base64');
    if (buffer.length < 12 + 16 + 1) throw new Error('short');
    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(buffer.length - 16);
    const encrypted = buffer.subarray(12, buffer.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    decoded = JSON.parse(plain);
  } catch {
    throw new Error('Failed to decrypt password (v2)');
  }
  if (typeof decoded.password !== 'string' || typeof decoded.userId !== 'string') {
    throw new Error('Failed to decrypt password (v2)');
  }
  return { password: decoded.password, userId: decoded.userId };
}

export function decryptPassword(encryptedString: string): { password: string, userId: string } {
  const versioned = VERSION_PREFIX_RE.exec(encryptedString);
  if (versioned) {
    if (versioned[0] === CREDENTIAL_CIPHERTEXT_V2_PREFIX) {
      return decryptPasswordV2(encryptedString.slice(versioned[0].length));
    }
    // Never fall back to the JWT_SECRET key for a prefixed value.
    throw new Error(`Unknown credential ciphertext version: ${versioned[1]}`);
  }
  try {
    const buffer = Buffer.from(encryptedString, 'base64');
    
    // Extract parts
    // IV is 16 bytes
    // AuthTag is 16 bytes (default for GCM)
    const iv = buffer.slice(0, 16);
    const authTag = buffer.slice(buffer.length - 16);
    const encryptedText = buffer.slice(16, buffer.length - 16);
    
    const key = deriveKey(getJwtSecret());
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText.toString('hex'), 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    // Verify signature and extract content
    const decoded = jwt.verify(decrypted, getJwtSecret()) as { password: string, userId: string };
    return decoded;
  } catch (error) {
    throw new Error('Failed to decrypt password');
  }
}
