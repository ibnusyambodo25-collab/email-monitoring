import pg from 'pg';
import { config } from '../config.js';

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL belum diisi di file .env. Lihat .env.example.');
}

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

pool.on('error', (err) => {
  console.error('[db] Koneksi idle PostgreSQL error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
