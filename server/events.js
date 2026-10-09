import { query } from './db/pool.js';

export async function logEvent(level, message, { detail = null, syncRunId = null, uidl = null } = {}) {
  const tag = level === 'error' ? 'ERROR' : level === 'warning' ? 'WARN' : 'INFO';
  console.log(`[${tag}] ${message}`);
  try {
    await query('INSERT INTO app_events (level, message, detail, sync_run_id, uidl) VALUES ($1, $2, $3, $4, $5)', [
      level,
      message,
      detail,
      syncRunId,
      uidl,
    ]);
  } catch (err) {
    console.error('[events] gagal menyimpan log:', err.message);
  }
}
