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

export function decryptPassword(encryptedString: string): { password: string, userId: string } {
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
