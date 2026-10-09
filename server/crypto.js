import crypto from 'node:crypto';
import { config } from './config.js';

// Password POP3 dienkripsi AES-256-GCM. Kunci diambil dari APP_ENCRYPTION_KEY (.env).

export function loadKey(raw = config.encryptionKey) {
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY belum diisi di file .env. Lihat .env.example.');
  }
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY harus 32 byte (base64 44 karakter atau hex 64 karakter).');
  }
  return key;
}

export function encryptSecret(plaintext, key = loadKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

export function decryptSecret({ iv, tag, ct }, key = loadKey()) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      'Password POP3 tersimpan tidak bisa dibuka. Kemungkinan APP_ENCRYPTION_KEY di .env berubah. ' +
        'Isi ulang password di halaman Pengaturan.',
    );
  }
}
