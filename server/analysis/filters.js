import { ValidationError } from '../settings.js';

// Zona waktu tampilan dan agregasi per jam/hari.
export const TZ = `'Asia/Jakarta'`;

export const DIRECTIONS = ['inbound', 'outbound', 'internal', 'forward', 'unknown'];

// Pengumpul parameter query: setiap nilai dari pengguna menjadi $n, tidak pernah
// disisipkan langsung ke teks SQL.
export class Sql {
  constructor() {
    this.params = [];
  }
  p(value) {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function parseDate(value, name) {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new ValidationError(`Parameter ${name} bukan tanggal yang valid.`);
  return d;
}

// Rentang [from, to). Default: 7 hari terakhir.
export function parseRange(q, defaultDays = 7) {
  const to = q.to ? parseDate(q.to, 'to') : new Date();
  const from = q.from ? parseDate(q.from, 'from') : new Date(to.getTime() - defaultDays * 86400_000);
  if (from >= to) throw new ValidationError('Tanggal awal harus sebelum tanggal akhir.');
  return { from, to };
}

/**
 * Kondisi WHERE dari parameter filter (alias tabel rejections = r).
 * Filter yang didukung: direction, category (bisa dipisah koma), probe=all|exclude|only,
 * sender, recipient, sender_domain, recipient_domain, final_recipient, report_id, q (cari teks).
 */
export function filterConditions(sql, q, { range = null } = {}) {
  const c = [];
  if (range) c.push(`r.waktu >= ${sql.p(range.from)} AND r.waktu < ${sql.p(range.to)}`);

  const dirs = list(q.direction).filter((d) => DIRECTIONS.includes(d));
  if (dirs.length) c.push(`r.direction = ANY(${sql.p(dirs)}::text[])`);
  const cats = list(q.category);
  if (cats.length) c.push(`r.reason_category = ANY(${sql.p(cats)}::text[])`);

  if (q.probe === 'exclude') c.push('NOT r.is_probe');
  else if (q.probe === 'only') c.push('r.is_probe');

  if (q.sender) c.push(`r.sender = ${sql.p(String(q.sender).trim().toLowerCase())}`);
  if (q.recipient) c.push(`r.recipient = ${sql.p(String(q.recipient).trim().toLowerCase())}`);
  if (q.final_recipient) c.push(`r.final_recipient = ${sql.p(String(q.final_recipient).trim().toLowerCase())}`);
  if (q.sender_domain) {
    const p = sql.p(String(q.sender_domain).trim().toLowerCase());
    c.push(`(r.sender_base_domain = ${p} OR r.sender_domain = ${p})`);
  }
  if (q.recipient_domain) c.push(`r.recipient_domain = ${sql.p(String(q.recipient_domain).trim().toLowerCase())}`);
  if (q.report_id) c.push(`r.report_id = ${sql.p(Number(q.report_id))}`);
  if (q.q && String(q.q).trim()) {
    const needle = String(q.q).trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    c.push(`r.search_text LIKE ${sql.p(`%${needle}%`)}`);
  }
  return c;
}

export const where = (conds) => (conds.length ? `WHERE ${conds.join(' AND ')}` : '');
