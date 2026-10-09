// npm run fetch — menjalankan satu kali pengambilan email dari terminal
// (memakai konfigurasi POP3 yang tersimpan lewat halaman Pengaturan).
import { pool } from '../db/pool.js';
import { startSync } from '../sync.js';

try {
  const result = await startSync('manual');
  console.log(result.ok ? `OK: ${result.message}` : `GAGAL: ${result.message}`);
  if (result.stats) console.table(result.stats);
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  console.error(`GAGAL: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
