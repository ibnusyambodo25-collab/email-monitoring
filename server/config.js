import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  encryptionKey: process.env.APP_ENCRYPTION_KEY,
  port: Number(process.env.APP_PORT || 3000),
  // Default hanya lokal. APP_HOST=0.0.0.0 membuka akses (lihat-saja) untuk PC lain di jaringan.
  host: (process.env.APP_HOST || '127.0.0.1').trim(),
  get lanEnabled() {
    return !['127.0.0.1', 'localhost', '::1'].includes(this.host);
  },
  allowedHosts: String(process.env.APP_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rawDir: process.env.RAW_DIR ? path.resolve(ROOT, process.env.RAW_DIR) : path.join(ROOT, 'data', 'raw'),
  webDist: path.join(ROOT, 'web', 'dist'),
  timezone: 'Asia/Jakarta',
};
