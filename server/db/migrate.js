import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { pool } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Menjalankan file migrasi .sql yang belum pernah dijalankan, berurutan menurut nama.
// Aman dijalankan ulang: yang sudah tercatat di schema_migrations dilewati, dan
// isi file migrasi sendiri juga memakai IF NOT EXISTS / ON CONFLICT.
// Jika database di DATABASE_URL belum ada, buat otomatis (lewat database "postgres").
async function ensureDatabase(log) {
  try {
    const c = await pool.connect();
    c.release();
  } catch (err) {
    if (err.code !== '3D000') throw err;
    const url = new URL(config.databaseUrl);
    const dbName = decodeURIComponent(url.pathname.slice(1));
    url.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      log(`[migrate] database "${dbName}" dibuat.`);
    } finally {
      await admin.end();
    }
  }
}

export async function migrate({ log = console.log } = {}) {
  await ensureDatabase(log);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migrasi ${file} gagal: ${err.message}`);
      }
      log(`[migrate] diterapkan: ${file}`);
      count++;
    }
    log(count ? `[migrate] selesai, ${count} migrasi baru.` : '[migrate] database sudah terbaru.');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(`[migrate] ${err.message}`);
      await pool.end();
      process.exitCode = 1;
    });
}
