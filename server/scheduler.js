import cron from 'node-cron';
import { query } from './db/pool.js';
import { startSync, isSyncRunning } from './sync.js';

// node-cron berdetak tiap menit; sinkronisasi otomatis dijalankan bila sudah lewat
// N menit sejak sinkronisasi terakhir dimulai (manual maupun otomatis). Dengan cara
// ini interval berapa pun (mis. 90 menit) bisa dipakai, dan perubahan interval di
// Pengaturan langsung berlaku tanpa restart.

let task = null;
let nextRunAt = null;

async function tick() {
  const { rows } = await query(
    `SELECT s.auto_fetch_enabled, s.fetch_interval_minutes,
            (s.pop3_host <> '' AND s.pop3_username <> '' AND s.pop3_password_ct IS NOT NULL) AS configured,
            (SELECT max(started_at) FROM sync_runs) AS last_started
       FROM settings s WHERE s.id = 1`,
  );
  const { auto_fetch_enabled: enabled, fetch_interval_minutes: minutes, configured, last_started: last } = rows[0];
  // Belum dikonfigurasi: jangan memenuhi log dengan error tiap jam.
  if (!enabled || !configured) {
    nextRunAt = null;
    return;
  }
  const due = last ? new Date(new Date(last).getTime() + minutes * 60_000) : new Date();
  nextRunAt = due;
  if (Date.now() >= due.getTime() && !isSyncRunning()) {
    nextRunAt = new Date(Date.now() + minutes * 60_000);
    await startSync('auto');
  }
}

export function startScheduler() {
  const run = () => tick().catch((err) => console.error('[scheduler]', err.message));
  task = cron.schedule('* * * * *', run, { name: 'auto-fetch', noOverlap: true });
  run();
}

export function stopScheduler() {
  task?.stop();
}

export function getNextRunAt() {
  return nextRunAt;
}

export function refreshSchedule() {
  tick().catch((err) => console.error('[scheduler]', err.message));
}
