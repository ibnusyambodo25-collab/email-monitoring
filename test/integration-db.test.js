// Test integrasi: server POP3 palsu → sinkronisasi → PostgreSQL (database *_test) → API.
import { hasDb, resetTestDb } from './helpers/testDb.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startFakePop3 } from './helpers/fakePop3.js';
import { alertEmail, alertWithoutCsv, unrelatedEmail, spoofedDisplayName } from './fixtures/emails.js';

const PASS = 'Rahasia-Integrasi-42';
const USER = 'erwin.it@gracia.co.id';
const opts = { skip: hasDb ? false : 'DATABASE_URL belum diisi di .env' };

let pool, srv, server, base;

before(async () => {
  if (!hasDb) return;
  pool = await resetTestDb();
  srv = await startFakePop3({
    user: USER,
    password: PASS,
    messages: [
      { uidl: 'n1', raw: unrelatedEmail(1) },
      { uidl: 'a1', raw: alertEmail() },
      { uidl: 's1', raw: spoofedDisplayName() },
      { uidl: 'x1', raw: alertWithoutCsv() },
    ],
  });
  const { createApp } = await import('../server/app.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await srv?.close();
  await pool?.end();
});

const api = (p, init = {}) =>
  fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });

test('database yang dipakai adalah database test', opts, async () => {
  const { rows } = await pool.query('SELECT current_database() AS db');
  assert.match(rows[0].db, /_test$/);
});

test('simpan pengaturan: password terenkripsi dan tidak pernah dikirim balik', opts, async () => {
  const res = await api('/settings', {
    method: 'PUT',
    body: JSON.stringify({ pop3_host: '127.0.0.1', pop3_port: srv.port, pop3_tls: false, pop3_username: USER, password: PASS }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(PASS));
  assert.equal(JSON.parse(text).settings.has_password, true);

  const get = await (await api('/settings')).text();
  assert.ok(!get.includes(PASS));
  assert.ok(!get.includes('pop3_password'));

  const { rows } = await pool.query('SELECT pop3_password_ct FROM settings');
  assert.ok(!rows[0].pop3_password_ct.toString('utf8').includes(PASS));
});

test('validasi pengaturan menolak input salah dengan pesan jelas', opts, async () => {
  const res = await api('/settings', { method: 'PUT', body: JSON.stringify({ watch_sender: 'bukan-email' }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /alamat email/);
});

test('tes koneksi: berhasil, lalu password salah tanpa membocorkan password', opts, async () => {
  const ok = await (await api('/settings/test-connection', { method: 'POST', body: '{}' })).json();
  assert.equal(ok.ok, true);
  assert.match(ok.message, /4 email/);

  // Password tersimpan tidak boleh dikirim ke server/username lain.
  const before = srv.commands.length;
  const other = await (await api('/settings/test-connection', { method: 'POST', body: JSON.stringify({ pop3_host: 'localhost' }) })).json();
  assert.equal(other.ok, false);
  assert.match(other.message, /Ketik password/);
  const otherUser = await (await api('/settings/test-connection', { method: 'POST', body: JSON.stringify({ pop3_username: 'lain@x.com' }) })).json();
  assert.match(otherUser.message, /Ketik password/);
  assert.equal(srv.commands.length, before, 'server tidak boleh dihubungi');

  const wrong = 'SalahSekali-777';
  const bad = await (await api('/settings/test-connection', { method: 'POST', body: JSON.stringify({ password: wrong }) })).json();
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'AUTH_FAILED');
  assert.ok(!JSON.stringify(bad).includes(wrong));
});

test('sinkronisasi: report diimpor ke database, file asli tersimpan, tanpa DELE', opts, async () => {
  const { startSync } = await import('../server/sync.js');
  const result = await startSync('manual');
  assert.equal(result.ok, true, result.message);
  assert.equal(result.stats.reportsImported, 1);
  assert.equal(result.stats.rowsImported, 4);
  assert.ok(!srv.commands.some((c) => /^DELE/.test(c)));
  assert.deepEqual(srv.commands.filter((c) => c.startsWith('RETR')), ['RETR 2', 'RETR 4']);

  const msgs = Object.fromEntries((await pool.query('SELECT uidl, status FROM mailbox_messages')).rows.map((r) => [r.uidl, r.status]));
  assert.deepEqual(msgs, { n1: 'ignored', a1: 'imported', s1: 'ignored', x1: 'no_csv' });

  const rep = (await pool.query('SELECT * FROM reports')).rows[0];
  assert.equal(rep.uidl, 'a1');
  assert.match(rep.stored_path, /^2026\/10\/2026-10-08_10-00-03_rejected_email_hourly_[0-9a-f]{8}\.csv$/);
  assert.ok(fs.existsSync(path.join(process.env.RAW_DIR, rep.stored_path)));

  const cats = (await pool.query('SELECT reason_category, count(*)::int n FROM rejections GROUP BY 1')).rows;
  assert.deepEqual(cats, [{ reason_category: 'no_such_user', n: 4 }]);

  // Email cocok tanpa CSV muncul sebagai peringatan di Status.
  const status = await (await api('/status')).json();
  assert.equal(status.mailbox.noCsv, 1);
  assert.equal(status.problems[0].uidl, 'x1');
  const events = await (await api('/events?level=warning')).json();
  assert.ok(events.items.some((e) => /tidak memiliki lampiran CSV/.test(e.message)));
});

test('sinkronisasi kedua tidak menggandakan data', opts, async () => {
  const { startSync } = await import('../server/sync.js');
  srv.commands.length = 0;
  const result = await startSync('manual');
  assert.equal(result.stats.messagesNew, 0);
  const { rows } = await pool.query('SELECT count(*)::int n FROM rejections');
  assert.equal(rows[0].n, 4);
  assert.ok(!srv.commands.some((c) => /^(TOP|RETR|DELE)/.test(c)));
});

test('mengubah filter subjek membuat email "tidak cocok" diperiksa ulang', opts, async () => {
  const res = await (await api('/settings', { method: 'PUT', body: JSON.stringify({ watch_subject: 'Promo bulan ini' }) })).json();
  assert.match(res.notes[0], /2 email/);
  await api('/settings', { method: 'PUT', body: JSON.stringify({ watch_subject: '[ALERT HOURLY] Ada Email Rejected/Gagal ke @gracia.co.id' }) });
});

test('pengaman lokal: Host asing, Origin asing, dan non-JSON ditolak', opts, async () => {
  const port = server.address().port;
  // fetch() tidak mengizinkan header Host diubah, jadi pakai http.request.
  const evilHostStatus = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/settings', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(evilHostStatus, 403);
  const evilOrigin = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(evilOrigin.status, 403);
  const form = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1',
  });
  assert.equal(form.status, 415);
});
