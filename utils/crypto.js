/**
 * AES-256-GCM Encryption Utility with GZIP Compression
 * Shared between Android app and backend for E2E encryption of sensitive data.
 *
 * Format: { encrypted: true, compressed: bool, iv: base64, tag: base64, data: base64 }
 * - iv: 12-byte initialization vector (random per message)
 * - tag: 16-byte GCM authentication tag (integrity)
 * - data: AES-256-GCM ciphertext (base64)
 * - compressed: if true, data was GZIP-compressed before encryption
 *
 * The Android app (CryptoUtil.kt) GZIP-compresses data before encryption to
 * reduce payload size by ~70%. The backend must decompress after decryption
 * when the 'compressed' flag is true.
 */

const crypto = require('crypto');
const zlib = require('zlib');

// Pre-shared 256-bit key (32 bytes) — must match Android CryptoUtil.kt
const PASSPHRASE = process.env.E2E_PASSPHRASE || 'LeaksProE2E_2025_SecureKey!';
const AES_KEY = crypto.createHash('sha256').update(PASSPHRASE).digest();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // GCM recommended IV size
const TAG_LENGTH = 16; // GCM auth tag size

/**
 * Encrypt a JSON object → encrypted envelope
 * @param {Object} data - Plain JSON object to encrypt
 * @returns {Object} - { encrypted: true, compressed: bool, iv, tag, data }
 */
function encrypt(data) {
  const plaintext = JSON.stringify(data);

  // GZIP compress (only if it actually reduces size)
  let compressedData;
  let isCompressed = false;
  try {
    const gzipped = zlib.gzipSync(Buffer.from(plaintext, 'utf8'));
    if (gzipped.length < plaintext.length) {
      compressedData = gzipped;
      isCompressed = true;
    } else {
      compressedData = Buffer.from(plaintext, 'utf8');
    }
  } catch (e) {
    compressedData = Buffer.from(plaintext, 'utf8');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, AES_KEY, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(compressedData),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: true,
    compressed: isCompressed,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

/**
 * Decrypt an encrypted envelope → plain JSON object
 * @param {Object} envelope - { encrypted: true, compressed: bool, iv, tag, data }
 * @returns {Object|null} - Decrypted JSON object, or null on failure
 */
function decrypt(envelope) {
  try {
    if (!envelope || !envelope.encrypted) return envelope; // Not encrypted, pass through

    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.data, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, AES_KEY, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    // ═══ GZIP DECOMPRESSION (Feature 9 compatibility) ═══
    // If the 'compressed' flag is true, the decrypted data is GZIP-compressed.
    // Decompress before parsing as JSON.
    let plaintext;
    if (envelope.compressed === true) {
      try {
        plaintext = zlib.gunzipSync(decrypted).toString('utf8');
      } catch (gzErr) {
        // GZIP decompression failed — try parsing as-is (maybe it wasn't actually compressed)
        plaintext = decrypted.toString('utf8');
      }
    } else {
      plaintext = decrypted.toString('utf8');
    }

    return JSON.parse(plaintext);
  } catch (err) {
    console.error('[Crypto] Decryption failed:', err.message);
    return null;
  }
}

/**
 * Try to decrypt data — if it's an encrypted envelope, decrypt it.
 * If it's plain data (not encrypted), return as-is.
 * This provides backward compatibility with unencrypted clients.
 */
function tryDecrypt(data) {
  if (data && data.encrypted === true && data.iv && data.tag && data.data) {
    const decrypted = decrypt(data);
    return decrypted || data; // Fallback to raw if decryption fails
  }
  return data; // Not encrypted, return as-is
}

module.exports = { encrypt, decrypt, tryDecrypt };
