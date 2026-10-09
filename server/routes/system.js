import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getPublicSettings, updateSettings } from '../settings.js';
import { startSync, isSyncRunning, testConnection, resetIgnoredMessages, retryFailedMessages } from '../sync.js';
import { getNextRunAt, refreshSchedule } from '../scheduler.js';
import { logEvent } from '../events.js';

export const systemRouter = Router();

// ---------- Pengaturan ----------

systemRouter.get('/settings', async (_req, res) => {
  res.json(await getPublicSettings());
});

systemRouter.put('/settings', async (req, res) => {
  const result = await updateSettings(req.body || {});
  const notes = [];
  if (result.filterChanged) {
    const n = await resetIgnoredMessages();
    notes.push(`Filter berubah: ${n} email yang sebelumnya tidak cocok akan diperiksa ulang pada pengambilan berikutnya.`);
  }
  if (result.classificationChanged) {
    const { rows } = await query('SELECT classify_rejections() AS n');
    notes.push(`Daftar domain pengecek diperbarui: ${rows[0].n} baris diklasifikasi ulang.`);
  }
  if (result.scheduleChanged) refreshSchedule();
  await logEvent('info', 'Pengaturan disimpan.', { detail: notes.join('\n') || null });
  res.json({ settings: result.settings, notes });
});

systemRouter.post('/settings/test-connection', async (req, res) => {
  res.json(await testConnection(req.body || {}));
});

// ---------- Sinkronisasi ----------

systemRouter.post('/sync', (_req, res) => {
  const promise = startSync('manual'); // melempar 409 jika sedang berjalan
  promise.catch((err) => console.error('[sync]', err.message));
  res.status(202).json({ started: true });
});

systemRouter.post('/mailbox/rescan-ignored', async (_req, res) => {
  const n = await resetIgnoredMessages();
  res.json({ message: `${n} email akan diperiksa ulang pada pengambilan berikutnya.` });
});

systemRouter.post('/mailbox/retry-failed', async (_req, res) => {
  const n = await retryFailedMessages();
  res.json({ message: `${n} email yang gagal akan dicoba lagi pada pengambilan berikutnya.` });
});

// ---------- Status ----------

systemRouter.get('/status', async (_req, res) => {
  const [lastRun, lastSuccess, counts, totals, problems] = await Promise.all([
    query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1'),
    query(`SELECT finished_at FROM sync_runs WHERE status IN ('success', 'partial') ORDER BY started_at DESC LIMIT 1`),
    query(`SELECT status, count(*)::int AS n FROM mailbox_messages GROUP BY status`),
    query(`SELECT
             (SELECT count(*)::int FROM reports) AS reports,
             (SELECT count(*)::int FROM rejections) AS rows,
             (SELECT count(*)::int FROM parse_errors) AS parse_errors,
             (SELECT max(email_date) FROM reports) AS latest_report_date`),
    query(`SELECT uidl, status, subject, email_date, attempts, last_error, processed_at
             FROM mailbox_messages WHERE status IN ('no_csv', 'error')
            ORDER BY coalesce(email_date, processed_at) DESC LIMIT 50`),
  ]);
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  res.json({
    running: isSyncRunning(),
    nextRunAt: getNextRunAt(),
    lastRun: lastRun.rows[0] || null,
    lastSuccessAt: lastSuccess.rows[0]?.finished_at || null,
    mailbox: {
      imported: byStatus.imported || 0,
      noCsv: byStatus.no_csv || 0,
      error: byStatus.error || 0,
      ignored: byStatus.ignored || 0,
    },
    totals: totals.rows[0],
    problems: problems.rows,
  });
});

systemRouter.get('/events', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const level = ['info', 'warning', 'error'].includes(req.query.level) ? req.query.level : null;
  const { rows } = await query(
    `SELECT id, created_at, level, message, detail, uidl, count(*) OVER()::int AS total
       FROM app_events WHERE ($1::text IS NULL OR level = $1)
      ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [level, limit, offset],
  );
  res.json({ total: rows[0]?.total || 0, items: rows.map(({ total, ...r }) => r) });
});

systemRouter.get('/sync-runs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const { rows } = await query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT $1', [limit]);
  res.json(rows);
});

// ---------- Report (file CSV asli) ----------

systemRouter.get('/reports', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { rows } = await query(
    `SELECT id, source, uidl, email_date, original_filename, stored_path, encoding, delimiter,
            row_count, error_count, imported_at, count(*) OVER()::int AS total
       FROM reports ORDER BY coalesce(email_date, imported_at) DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  res.json({ total: rows[0]?.total || 0, items: rows.map(({ total, ...r }) => r) });
});

systemRouter.get('/reports/:id/errors', async (req, res) => {
  const { rows } = await query('SELECT line_no, raw_line, message FROM parse_errors WHERE report_id = $1 ORDER BY line_no NULLS FIRST', [
    Number(req.params.id),
  ]);
  res.json(rows);
});

systemRouter.get('/reports/:id/raw', async (req, res) => {
  const { rows } = await query('SELECT stored_path FROM reports WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Report tidak ditemukan.' });
  const abs = path.resolve(config.rawDir, rows[0].stored_path);
  if (!abs.startsWith(path.resolve(config.rawDir) + path.sep) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'File asli tidak ditemukan di folder data/raw.' });
  }
  res.download(abs, path.basename(abs));
});
