import { query } from './db/pool.js';
import { encryptSecret, decryptSecret } from './crypto.js';

const PUBLIC_COLUMNS = `
  pop3_host, pop3_port, pop3_tls, pop3_allow_invalid_cert, pop3_username,
  (pop3_password_ct IS NOT NULL) AS has_password,
  watch_sender, watch_subject, fetch_interval_minutes, auto_fetch_enabled,
  internal_domain, probe_domains,
  spike_ratio::float AS spike_ratio, spike_min_count, recurring_min_days, updated_at`;

// Pengaturan untuk ditampilkan/dikirim ke frontend: TANPA password.
export async function getPublicSettings() {
  const { rows } = await query(`SELECT ${PUBLIC_COLUMNS} FROM settings WHERE id = 1`);
  return rows[0];
}

// Pengaturan lengkap untuk dipakai server, termasuk password yang sudah didekripsi.
export async function getSettingsWithSecret() {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, pop3_password_iv AS iv, pop3_password_tag AS tag, pop3_password_ct AS ct
       FROM settings WHERE id = 1`,
  );
  const { iv, tag, ct, ...settings } = rows[0];
  return { ...settings, password: ct ? decryptSecret({ iv, tag, ct }) : null };
}

const isHost = (s) => /^[a-z0-9.-]+$/i.test(s) || /^\[?[0-9a-f:.]+\]?$/i.test(s);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isDomain = (s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Validasi + normalisasi input dari halaman Pengaturan. Hanya field yang dikirim yang diubah.
export function validateSettingsInput(body) {
  const out = {};
  const str = (k) => (body[k] === undefined ? undefined : String(body[k] ?? '').trim());

  const host = str('pop3_host');
  if (host !== undefined) {
    if (host && !isHost(host)) throw new ValidationError('Nama server POP3 tidak valid.');
    out.pop3_host = host;
  }
  if (body.pop3_port !== undefined) {
    const port = Number(body.pop3_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError('Port harus angka 1–65535.');
    out.pop3_port = port;
  }
  for (const k of ['pop3_tls', 'pop3_allow_invalid_cert', 'auto_fetch_enabled']) {
    if (body[k] !== undefined) out[k] = Boolean(body[k]);
  }
  const username = str('pop3_username');
  if (username !== undefined) out.pop3_username = username;

  const sender = str('watch_sender');
  if (sender !== undefined) {
    if (!isEmail(sender)) throw new ValidationError('Alamat pengirim yang diawasi harus berupa alamat email.');
    out.watch_sender = sender.toLowerCase();
  }
  const subject = str('watch_subject');
  if (subject !== undefined) {
    if (!subject) throw new ValidationError('Subjek yang diawasi tidak boleh kosong.');
    out.watch_subject = subject;
  }
  if (body.fetch_interval_minutes !== undefined) {
    const n = Number(body.fetch_interval_minutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) throw new ValidationError('Interval pengambilan harus 1–1440 menit.');
    out.fetch_interval_minutes = n;
  }
  const internal = str('internal_domain');
  if (internal !== undefined) {
    if (!isDomain(internal)) throw new ValidationError('Domain internal tidak valid (contoh: gracia.co.id).');
    out.internal_domain = internal.toLowerCase();
  }
  if (body.probe_domains !== undefined) {
    const list = (Array.isArray(body.probe_domains) ? body.probe_domains : String(body.probe_domains).split(/[\s,;]+/))
      .map((d) => String(d).trim().toLowerCase())
      .filter(Boolean);
    const bad = list.find((d) => !isDomain(d));
    if (bad) throw new ValidationError(`Domain pengecek tidak valid: ${bad}`);
    out.probe_domains = [...new Set(list)];
  }
  if (body.spike_ratio !== undefined) {
    const n = Number(body.spike_ratio);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new ValidationError('Rasio lonjakan harus angka 1–100 (contoh: 2 = dua kali rata-rata).');
    out.spike_ratio = n;
  }
  if (body.spike_min_count !== undefined) {
    const n = Number(body.spike_min_count);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError('Minimal jumlah lonjakan harus bilangan bulat ≥ 1.');
    out.spike_min_count = n;
  }
  if (body.recurring_min_days !== undefined) {
    const n = Number(body.recurring_min_days);
    if (!Number.isInteger(n) || n < 2 || n > 365) throw new ValidationError('Batas "berulang" harus 2–365 hari.');
    out.recurring_min_days = n;
  }
  return out;
}

/**
 * Simpan pengaturan. Password hanya diubah jika `password` diisi (string tidak kosong),
 * atau dihapus jika `clear_password` true. Password tidak pernah dikembalikan.
 * Mengembalikan daftar hal yang berubah supaya pemanggil bisa menindaklanjuti.
 */
export async function updateSettings(body) {
  const fields = validateSettingsInput(body);
  if (typeof body.password === 'string' && body.password !== '') {
    const { iv, tag, ct } = encryptSecret(body.password);
    Object.assign(fields, { pop3_password_iv: iv, pop3_password_tag: tag, pop3_password_ct: ct });
  } else if (body.clear_password === true) {
    Object.assign(fields, { pop3_password_iv: null, pop3_password_tag: null, pop3_password_ct: null });
  }

  const before = await getPublicSettings();
  const keys = Object.keys(fields);
  if (keys.length) {
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await query(`UPDATE settings SET ${sets}, updated_at = now() WHERE id = 1`, keys.map((k) => fields[k]));
  }
  const after = await getPublicSettings();
  return {
    settings: after,
    filterChanged: before.watch_sender !== after.watch_sender || before.watch_subject !== after.watch_subject,
    classificationChanged:
      before.internal_domain !== after.internal_domain ||
      JSON.stringify(before.probe_domains) !== JSON.stringify(after.probe_domains),
    scheduleChanged:
      before.fetch_interval_minutes !== after.fetch_interval_minutes || before.auto_fetch_enabled !== after.auto_fetch_enabled,
  };
}
