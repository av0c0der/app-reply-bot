/**
 * AES-256-GCM encryption for credential data at rest.
 *
 * Encrypted payloads are stored as:  iv:authTag:ciphertext  (hex-encoded, colon-separated)
 *
 * The key is read from ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16;

let _key: Buffer | null = null;

function getKey(): Buffer {
    if (_key) return _key;

    const hex = process.env.ENCRYPTION_KEY;
    if (!hex) {
        throw new Error('Missing ENCRYPTION_KEY environment variable');
    }
    if (hex.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }

    _key = Buffer.from(hex, 'hex');
    return _key;
}

export function encrypt(plaintext: string): string {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(payload: string): string {
    const key = getKey();
    const parts = payload.split(':');

    if (parts.length !== 3) {
        throw new Error('Invalid encrypted payload format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * Check whether a string looks like an encrypted payload (hex:hex:hex).
 * Used during migration to distinguish already-encrypted values from plaintext.
 */
export function isEncrypted(value: string): boolean {
    return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(value);
}

/**
 * Generate a random 32-byte key and return it as a 64-char hex string.
 */
export function generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
}
