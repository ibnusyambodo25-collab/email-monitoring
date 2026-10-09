import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseReportCsv } from './csv.js';
import { enrichRow } from './enrich.js';

const INSERT_CHUNK = 1000;

function jakartaStamp(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    dir: path.join(parts.year, parts.month),
    stamp: `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`,
  };
}

function safeName(name) {
  return path.basename(name).replace(/[^\w.-]+/g, '_').replace(/\.csv$/i, '') || 'report';
}

// data/raw/2026/10/2026-10-08_12-05-03_rejected_email_hourly_ab12cd34.csv
export async function saveRawFile({ content, filename, date, uniqueTag }) {
  const { dir, stamp } = jakartaStamp(date || new Date());
  const rel = path.join(dir, `${stamp}_${safeName(filename)}_${uniqueTag}.csv`);
  const abs = path.join(config.rawDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return rel.split(path.sep).join('/');
}

async function insertRows(db, reportId, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const col = (k) => chunk.map((r) => r[k] ?? null);
    await db.query(
      `INSERT INTO rejections (
         report_id, line_no, waktu, pengirim, penerima, penyebab, penyebab_bersih,
         sender, sender_domain, sender_base_domain, recipient, recipient_domain, final_recipient,
         direction, smtp_code, enhanced_code, router, remote_host)
       SELECT $1, * FROM unnest(
         $2::int[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[],
         $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[],
         $14::text[], $15::text[], $16::text[], $17::text[], $18::text[])`,
      [
        reportId,
        col('lineNo'),
        col('waktu'),
        col('pengirim'),
        col('penerima'),
        col('penyebab'),
        col('penyebabBersih'),
        col('sender'),
        col('senderDomain'),
        col('senderBaseDomain'),
        col('recipient'),
        col('recipientDomain'),
        col('finalRecipient'),
        col('direction'),
        col('smtpCode'),
        col('enhancedCode'),
        col('router'),
        col('remoteHost'),
      ],
    );
  }
}

/**
 * Menyimpan satu lampiran CSV: file asli ke data/raw/, isi ke tabel rejections,
 * baris gagal ke parse_errors. Harus dipanggil di dalam transaksi (db = client).
 */
export async function ingestAttachment(db, { source, uidl = null, attachmentIndex = 0, emailDate, filename, content, internalDomain }) {
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const parsed = await parseReportCsv(content);
  const uniqueTag = (uidl ? crypto.createHash('sha1').update(uidl).digest('hex') : sha256).slice(0, 8);
  const storedPath = await saveRawFile({ content, filename, date: emailDate, uniqueTag });

  const enriched = parsed.rows.map((r) => enrichRow(r, { internalDomain }));
  const errors = parsed.fatal ? [{ lineNo: null, raw: null, message: parsed.fatal }, ...parsed.errors] : parsed.errors;

  const { rows } = await db.query(
    `INSERT INTO reports (source, uidl, attachment_index, email_date, original_filename, stored_path,
                          sha256, encoding, delimiter, row_count, error_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [source, uidl, attachmentIndex, emailDate, filename, storedPath, sha256, parsed.encoding, parsed.delimiter, enriched.length, errors.length],
  );
  const reportId = rows[0].id;

  await insertRows(db, reportId, enriched);
  if (errors.length) {
    await db.query(
      `INSERT INTO parse_errors (report_id, line_no, raw_line, message)
       SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[])`,
      [reportId, errors.map((e) => e.lineNo), errors.map((e) => e.raw), errors.map((e) => e.message)],
    );
  }
  await db.query('SELECT classify_rejections($1)', [reportId]);

  return { reportId, storedPath, rows: enriched.length, errors, fatal: parsed.fatal };
}
