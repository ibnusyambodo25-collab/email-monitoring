import { Router } from 'express';
import ExcelJS from 'exceljs';
import { query } from '../db/pool.js';
import { Sql, TZ, filterConditions, parseRange, where } from '../analysis/filters.js';

export const rejectionsRouter = Router();

const SORTS = {
  waktu: 'r.waktu',
  pengirim: 'r.pengirim',
  penerima: 'r.penerima',
  arah: 'r.direction',
  kategori: 'r.reason_category',
};

const SELECT_COLUMNS = `
  r.id, r.waktu, to_char(r.waktu AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI:SS') AS waktu_wib,
  r.pengirim, r.penerima, r.penyebab, r.penyebab_bersih, r.sender, r.recipient, r.final_recipient,
  r.direction, r.reason_category, coalesce(c.label, r.reason_category) AS reason_label,
  r.smtp_code, r.enhanced_code, r.router, r.remote_host, r.is_probe,
  r.report_id, r.line_no, rp.original_filename, rp.stored_path, rp.email_date`;

const FROM = `FROM rejections r
  JOIN reports rp ON rp.id = r.report_id
  LEFT JOIN reason_categories c ON c.code = r.reason_category`;

// Tabel detail: pencarian, filter, urutan, dan pagination di sisi server.
rejectionsRouter.get('/rejections', async (req, res) => {
  const q = req.query;
  const range = parseRange(q, 7);
  const page = Math.max(Number(q.page) || 1, 1);
  const pageSize = [25, 50, 100, 200].includes(Number(q.pageSize)) ? Number(q.pageSize) : 50;
  const sortCol = SORTS[q.sort] || SORTS.waktu;
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';

  const sql = new Sql();
  const w = where(filterConditions(sql, q, { range }));
  const countParams = [...sql.params];
  const [count, rows] = await Promise.all([
    query(`SELECT count(*)::int AS n FROM rejections r ${w}`, countParams),
    query(
      `SELECT ${SELECT_COLUMNS} ${FROM} ${w}
        ORDER BY ${sortCol} ${dir} NULLS LAST, r.id ${dir}
        LIMIT ${sql.p(pageSize)} OFFSET ${sql.p((page - 1) * pageSize)}`,
      sql.params,
    ),
  ]);
  res.json({ total: count.rows[0].n, page, pageSize, items: rows.rows });
});

const EXPORT_COLUMNS = [
  ['waktu_wib', 'Waktu (WIB)', 20],
  ['pengirim', 'Pengirim', 34],
  ['penerima', 'Penerima', 34],
  ['penyebab_bersih', 'Penyebab', 80],
  ['recipient', 'Penerima (terbaca)', 34],
  ['final_recipient', 'Tujuan forward/alias', 34],
  ['direction_label', 'Arah', 12],
  ['reason_label', 'Kategori', 36],
  ['smtp_code', 'Kode SMTP', 10],
  ['enhanced_code', 'Kode status', 12],
  ['probe_label', 'Pengecek email', 14],
  ['original_filename', 'File report', 34],
];

const DIRECTION_LABEL = { inbound: 'Masuk', outbound: 'Keluar', internal: 'Internal', forward: 'Forward', unknown: '-' };

// Mencegah "CSV injection": nilai dari email luar yang diawali = + - @ tidak boleh
// dianggap rumus oleh Excel.
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Ekspor semua baris hasil filter (bukan hanya satu halaman), dibaca bertahap dari DB.
rejectionsRouter.get('/rejections/export', async (req, res) => {
  const q = req.query;
  const format = q.format === 'xlsx' ? 'xlsx' : 'csv';
  const range = parseRange(q, 7);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `email-rejected_${stamp}.${format}`;

  async function* batches() {
    let last = null;
    for (;;) {
      const sql = new Sql();
      const conds = filterConditions(sql, q, { range });
      if (last) conds.push(`(r.waktu, r.id) > (${sql.p(last.waktu)}, ${sql.p(last.id)})`);
      const { rows } = await query(`SELECT ${SELECT_COLUMNS} ${FROM} ${where(conds)} ORDER BY r.waktu, r.id LIMIT 2000`, sql.params);
      if (!rows.length) return;
      yield rows.map((r) => ({ ...r, direction_label: DIRECTION_LABEL[r.direction], probe_label: r.is_probe ? 'Ya' : '' }));
      last = rows.at(-1);
    }
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.write('﻿' + EXPORT_COLUMNS.map(([, h]) => csvCell(h)).join(',') + '\r\n');
    for await (const rows of batches()) {
      res.write(rows.map((r) => EXPORT_COLUMNS.map(([k]) => csvCell(r[k])).join(',')).join('\r\n') + '\r\n');
    }
    return res.end();
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet('Email rejected', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map(([key, header, width]) => ({ key, header, width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  for await (const rows of batches()) {
    for (const r of rows) {
      ws.addRow(Object.fromEntries(EXPORT_COLUMNS.map(([k]) => [k, r[k] ?? '']))).commit();
    }
  }
  ws.commit();
  await wb.commit();
});
