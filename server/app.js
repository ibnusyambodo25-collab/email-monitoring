import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { accessGuard, canEdit } from './access.js';
import { systemRouter } from './routes/system.js';
import { analysisRouter } from './routes/analysis.js';
import { rejectionsRouter } from './routes/rejections.js';
import { rulesRouter } from './routes/rules.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(accessGuard);
  app.use(express.json({ limit: '1mb' }));

  // Apakah pengguna ini boleh mengubah pengaturan (hanya dari komputer server).
  app.get('/api/client', (req, res) => res.json({ canEdit: canEdit(req), lan: config.lanEnabled }));

  app.use('/api', systemRouter);
  app.use('/api', analysisRouter);
  app.use('/api', rejectionsRouter);
  app.use('/api', rulesRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));

  // Frontend hasil build (npm run build). Saat dev, Vite yang melayani frontend.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res.type('text').send('Frontend belum di-build. Jalankan "npm run build" lalu "npm start", atau gunakan "npm run dev".'),
    );
  }

  // Penanganan error terpusat. Pesan untuk pengguna; detail teknis hanya ke konsol.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[api]', err.stack || err.message);
    const message =
      status >= 500
        ? err.code === 'ECONNREFUSED'
          ? 'Tidak bisa terhubung ke database PostgreSQL. Pastikan layanan PostgreSQL berjalan dan DATABASE_URL di .env benar.'
          : 'Terjadi kesalahan di server. Lihat konsol server untuk detail.'
        : err.type === 'entity.parse.failed'
          ? 'Format JSON tidak valid.'
          : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}
