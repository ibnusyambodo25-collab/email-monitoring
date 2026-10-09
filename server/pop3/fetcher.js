import { parseHeaders, matchesWatch, parseFullEmail, extractCsvAttachments } from './match.js';
import { isConnectionLevelError, redact } from './errors.js';

export const MAX_ERROR_ATTEMPTS = 5;

/**
 * Satu putaran pengambilan email. Tidak bergantung langsung pada database supaya
 * bisa diuji dengan server POP3 palsu; penyimpanan lewat objek `repo`.
 *
 * Alur per email: UIDL → lewati yang sudah tercatat → TOP (header saja) →
 * cocokkan pengirim+subjek → baru RETR jika cocok → ambil lampiran CSV → ingest.
 * Tidak pernah memanggil DELE.
 *
 * repo:
 *   getKnownUidls(): Promise<Map<uidl, {status, attempts}>>
 *   saveMessage({uidl, status, headers, attachmentCount, error}): Promise<void>
 *   ingest({uidl, headers, emailDate, attachments}): Promise<{reports, rows, rowErrors}>
 *   event(level, message, detail?, uidl?): Promise<void>
 */
export async function runFetch({ client, repo, watch, secrets = [] }) {
  const stats = {
    messagesTotal: 0,
    messagesNew: 0,
    messagesMatched: 0,
    reportsImported: 0,
    rowsImported: 0,
    rowsFailed: 0,
    noCsv: 0,
    messageErrors: 0,
  };

  try {
    const list = await client.uidl();
    stats.messagesTotal = list.length;
    const known = await repo.getKnownUidls();

    for (const [msgNum, uidl] of list) {
      const prev = known.get(uidl);
      if (prev && !(prev.status === 'error' && prev.attempts < MAX_ERROR_ATTEMPTS)) continue;
      stats.messagesNew++;

      let headers = null;
      try {
        headers = await parseHeaders(await client.top(msgNum));
        if (!matchesWatch(headers, watch)) {
          await repo.saveMessage({ uidl, status: 'ignored', headers });
          continue;
        }
        stats.messagesMatched++;

        const mail = await parseFullEmail(await client.retr(msgNum));
        const attachments = extractCsvAttachments(mail);
        const emailDate = mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : headers.date;

        if (!attachments.length) {
          stats.noCsv++;
          await repo.saveMessage({ uidl, status: 'no_csv', headers, attachmentCount: 0 });
          await repo.event(
            'warning',
            `Email report "${headers.subject}" (${formatJakarta(emailDate)}) tidak memiliki lampiran CSV, sehingga tidak ada data yang diimpor.`,
            `UIDL ${uidl}; lampiran lain: ${(mail.attachments || []).map((a) => a.filename || a.contentType).join(', ') || '-'}`,
            uidl,
          );
          continue;
        }

        const res = await repo.ingest({ uidl, headers, emailDate, attachments });
        stats.reportsImported += res.reports;
        stats.rowsImported += res.rows;
        stats.rowsFailed += res.rowErrors;
      } catch (err) {
        if (isConnectionLevelError(err)) throw err;
        stats.messageErrors++;
        const detail = redact(err.stack || err.message, secrets);
        await repo.saveMessage({ uidl, status: 'error', headers, error: redact(err.message, secrets) });
        await repo.event(
          'error',
          `Gagal memproses satu email${headers?.subject ? ` ("${headers.subject}")` : ''}. Akan dicoba lagi pada sinkronisasi berikutnya (maksimal ${MAX_ERROR_ATTEMPTS} kali).`,
          detail,
          uidl,
        );
      }
    }
  } finally {
    await client.quit();
  }
  return stats;
}

export function formatJakarta(date) {
  if (!date) return 'tanggal tidak diketahui';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date) + ' WIB';
}
