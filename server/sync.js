import { query, withTransaction } from './db/pool.js';
import { getSettingsWithSecret } from './settings.js';
import { logEvent } from './events.js';
import { SafePop3Client } from './pop3/client.js';
import { runFetch, formatJakarta } from './pop3/fetcher.js';
import { describePop3Error } from './pop3/errors.js';
import { ingestAttachment } from './ingest/ingest.js';

let current = null;

export function isSyncRunning() {
  return current !== null;
}

export function createClient(s, password) {
  return new SafePop3Client({
    host: s.pop3_host,
    port: s.pop3_port,
    tls: s.pop3_tls,
    username: s.pop3_username,
    password,
    allowInvalidCert: s.pop3_allow_invalid_cert,
  });
}

export function missingConfig(s) {
  const missing = [];
  if (!s.pop3_host) missing.push('server POP3');
  if (!s.pop3_username) missing.push('username');
  if (!s.password) missing.push('password');
  return missing;
}

function dbRepo({ syncRunId, internalDomain }) {
  const saveMessage = (db, { uidl, status, headers, attachmentCount = 0, error = null }) =>
    db.query(
      `INSERT INTO mailbox_messages (uidl, status, from_address, subject, email_date, message_id, attachment_count, attempts, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $2 = 'error' THEN 1 ELSE 0 END, $8)
       ON CONFLICT (uidl) DO UPDATE SET
         status = EXCLUDED.status,
         from_address = COALESCE(EXCLUDED.from_address, mailbox_messages.from_address),
         subject = COALESCE(EXCLUDED.subject, mailbox_messages.subject),
         email_date = COALESCE(EXCLUDED.email_date, mailbox_messages.email_date),
         message_id = COALESCE(EXCLUDED.message_id, mailbox_messages.message_id),
         attachment_count = EXCLUDED.attachment_count,
         attempts = mailbox_messages.attempts + CASE WHEN EXCLUDED.status = 'error' THEN 1 ELSE 0 END,
         last_error = EXCLUDED.last_error,
         processed_at = now()`,
      [uidl, status, headers?.fromAddress ?? null, headers?.subject ?? null, headers?.date ?? null, headers?.messageId ?? null, attachmentCount, error],
    );

  return {
    async getKnownUidls() {
      const { rows } = await query('SELECT uidl, status, attempts FROM mailbox_messages');
      return new Map(rows.map((r) => [r.uidl, { status: r.status, attempts: r.attempts }]));
    },
    saveMessage: (args) => saveMessage({ query }, args),
    async ingest({ uidl, headers, emailDate, attachments }) {
      const results = await withTransaction(async (db) => {
        await saveMessage(db, { uidl, status: 'imported', headers, attachmentCount: attachments.length });
        await db.query('DELETE FROM reports WHERE uidl = $1', [uidl]); // sisa percobaan sebelumnya
        const out = [];
        for (const [i, att] of attachments.entries()) {
          out.push(
            await ingestAttachment(db, {
              source: 'pop3',
              uidl,
              attachmentIndex: i,
              emailDate,
              filename: att.filename,
              content: att.content,
              internalDomain,
            }),
          );
        }
        return out;
      });
      const when = formatJakarta(emailDate);
      for (const r of results) {
        if (r.fatal) {
          await logEvent('warning', `Report ${when} tidak bisa dibaca: ${r.fatal}`, { detail: `File: ${r.storedPath}`, syncRunId, uidl });
        } else if (r.errors.length) {
          await logEvent(
            'warning',
            `Report ${when}: ${r.rows} baris tersimpan, ${r.errors.length} baris gagal dibaca (lihat detail di halaman Status).`,
            { detail: r.errors.slice(0, 20).map((e) => `baris ${e.lineNo ?? '?'}: ${e.message}`).join('\n'), syncRunId, uidl },
          );
        }
      }
      return {
        reports: results.length,
        rows: results.reduce((a, r) => a + r.rows, 0),
        rowErrors: results.reduce((a, r) => a + r.errors.length, 0),
      };
    },
    event: (level, message, detail, uidl) => logEvent(level, message, { detail, syncRunId, uidl }),
  };
}

/**
 * Menjalankan satu sinkronisasi. Hanya satu yang boleh berjalan sekaligus.
 * Melempar error dengan status 409 bila sedang berjalan.
 */
export function startSync(trigger = 'manual') {
  if (current) {
    const err = new Error('Pengambilan email sedang berjalan. Tunggu sampai selesai.');
    err.status = 409;
    throw err;
  }
  current = doSync(trigger).finally(() => {
    current = null;
  });
  return current;
}

async function doSync(trigger) {
  const { rows } = await query('INSERT INTO sync_runs (trigger) VALUES ($1) RETURNING id', [trigger]);
  const syncRunId = rows[0].id;
  let settings = null;
  try {
    settings = await getSettingsWithSecret();
    const missing = missingConfig(settings);
    if (missing.length) {
      const msg = `Konfigurasi POP3 belum lengkap (${missing.join(', ')}). Lengkapi di halaman Pengaturan.`;
      await finishRun(syncRunId, 'failed', {}, msg);
      await logEvent('error', msg, { syncRunId });
      return { ok: false, message: msg };
    }

    const stats = await runFetch({
      client: createClient(settings, settings.password),
      repo: dbRepo({ syncRunId, internalDomain: settings.internal_domain }),
      watch: { watchSender: settings.watch_sender, watchSubject: settings.watch_subject },
      secrets: [settings.password],
    });

    const status = stats.messageErrors ? 'partial' : 'success';
    await finishRun(syncRunId, status, stats, null);
    const summary =
      stats.messagesMatched === 0
        ? `Sinkronisasi selesai: ${stats.messagesNew} email baru diperiksa, tidak ada report baru.`
        : `Sinkronisasi selesai: ${stats.reportsImported} report baru diimpor (${stats.rowsImported} baris` +
          `${stats.rowsFailed ? `, ${stats.rowsFailed} baris gagal dibaca` : ''}).`;
    await logEvent(status === 'success' ? 'info' : 'warning', summary, { syncRunId });
    return { ok: true, message: summary, stats };
  } catch (err) {
    const info = settings
      ? describePop3Error(err, { host: settings.pop3_host, port: settings.pop3_port, tls: settings.pop3_tls }, [settings.password])
      : { message: `Gagal memulai sinkronisasi: ${err.message}`, detail: err.stack };
    await finishRun(syncRunId, 'failed', {}, info.message);
    await logEvent('error', info.message, { detail: info.detail, syncRunId });
    return { ok: false, message: info.message };
  }
}

async function finishRun(id, status, s, errorMessage) {
  await query(
    `UPDATE sync_runs SET status = $2, finished_at = now(),
       messages_total = $3, messages_new = $4, messages_matched = $5,
       reports_imported = $6, rows_imported = $7, rows_failed = $8, error_message = $9
     WHERE id = $1`,
    [
      id,
      status,
      s.messagesTotal || 0,
      s.messagesNew || 0,
      s.messagesMatched || 0,
      s.reportsImported || 0,
      s.rowsImported || 0,
      s.rowsFailed || 0,
      errorMessage,
    ],
  );
}

// Tombol "Tes koneksi": login + STAT saja, tanpa membaca isi email.
// Nilai yang belum disimpan dari form boleh dipakai; password kosong = pakai yang tersimpan.
export async function testConnection(input) {
  const saved = await getSettingsWithSecret();
  const s = {
    ...saved,
    pop3_host: String(input.pop3_host ?? saved.pop3_host).trim(),
    pop3_port: Number(input.pop3_port ?? saved.pop3_port),
    pop3_tls: input.pop3_tls ?? saved.pop3_tls,
    pop3_allow_invalid_cert: input.pop3_allow_invalid_cert ?? saved.pop3_allow_invalid_cert,
    pop3_username: String(input.pop3_username ?? saved.pop3_username).trim(),
    password: typeof input.password === 'string' && input.password !== '' ? input.password : saved.password,
  };
  // Password tersimpan hanya boleh dikirim ke server & username yang sama dengan yang
  // tersimpan; kalau diganti, password harus diketik ulang (mencegah password terkirim
  // ke server lain).
  const typedPassword = typeof input.password === 'string' && input.password !== '';
  const target = (x) => `${String(x.pop3_host).toLowerCase()}|${String(x.pop3_username).toLowerCase()}`;
  if (!typedPassword && saved.password && target(s) !== target(saved)) {
    return { ok: false, message: 'Server atau username berbeda dari yang tersimpan. Ketik password untuk mengujinya.' };
  }
  const missing = missingConfig(s);
  if (missing.length) return { ok: false, message: `Lengkapi dulu: ${missing.join(', ')}.` };

  const client = createClient(s, s.password);
  try {
    const { count } = await client.stat();
    await client.quit();
    return { ok: true, message: `Berhasil terhubung ke ${s.pop3_host}. Ada ${count} email di mailbox.` };
  } catch (err) {
    client.destroy();
    const info = describePop3Error(err, { host: s.pop3_host, port: s.pop3_port, tls: s.pop3_tls }, [s.password]);
    return { ok: false, message: info.message, kind: info.kind };
  }
}

// Setelah filter pengirim/subjek diubah: email yang dulu "tidak cocok" diperiksa ulang.
export async function resetIgnoredMessages() {
  const { rowCount } = await query(`DELETE FROM mailbox_messages WHERE status = 'ignored'`);
  return rowCount;
}

// Email cocok yang gagal diproses 5x berhenti dicoba; tombol ini mengizinkan coba lagi.
export async function retryFailedMessages() {
  const { rowCount } = await query(`UPDATE mailbox_messages SET attempts = 0 WHERE status = 'error'`);
  return rowCount;
}
