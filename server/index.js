import { config } from './config.js';
import { pool } from './db/pool.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { lanUrls } from './access.js';

async function main() {
  try {
    await pool.query('SELECT 1 FROM settings LIMIT 1');
  } catch (err) {
    if (err.code === '42P01') {
      console.error('Tabel database belum ada. Jalankan dulu: npm run migrate');
    } else {
      console.error(`Tidak bisa terhubung ke PostgreSQL: ${err.message}\nPeriksa DATABASE_URL di file .env.`);
    }
    process.exit(1);
  }

  const app = createApp();
  // Express 5 memanggil callback listen juga saat gagal (dengan argumen error).
  const server = app.listen(config.port, config.host, (err) => {
    if (err) {
      console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} sudah dipakai program lain. Ubah APP_PORT di .env.` : err.message);
      process.exit(1);
    }
    console.log(`Server berjalan di http://localhost:${config.port}${config.lanEnabled ? '' : ' (hanya lokal)'}`);
    if (config.lanEnabled) {
      console.log('Mode LAN aktif. PC lain di jaringan bisa membuka (lihat-saja):');
      for (const url of lanUrls(config.port)) console.log(`  ${url}`);
      console.log('Pengaturan hanya bisa diubah dari komputer ini.');
    }
    startScheduler();
  });

  const shutdown = async () => {
    stopScheduler();
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
