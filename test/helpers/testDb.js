// Menyiapkan database KHUSUS TEST (<nama_db>_test) dan folder data sementara, supaya
// test integrasi tidak menyentuh data maupun pengaturan sungguhan.
// Harus di-import SEBELUM modul server mana pun.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* tanpa .env: test integrasi dilewati */
}

export const hasDb = Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('GANTI_PASSWORD'));

if (hasDb) {
  const url = new URL(process.env.DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
  process.env.DATABASE_URL = url.toString();
  process.env.RAW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-raw-'));
  if (!process.env.APP_ENCRYPTION_KEY) process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}

export async function resetTestDb() {
  const { migrate } = await import('../../server/db/migrate.js');
  const { pool } = await import('../../server/db/pool.js');
  await migrate({ log: () => {} });
  const { rows } = await pool.query('SELECT current_database() AS db');
  if (!rows[0].db.endsWith('_test')) {
    throw new Error(`Pengaman: test hanya boleh berjalan di database *_test, bukan "${rows[0].db}".`);
  }
  await pool.query(`TRUNCATE parse_errors, rejections, reports, mailbox_messages, app_events, sync_runs RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM settings; INSERT INTO settings (id) VALUES (1)`);
  return pool;
}
