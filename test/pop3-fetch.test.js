import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SafePop3Client, dotUnstuff } from '../server/pop3/client.js';
import { runFetch } from '../server/pop3/fetcher.js';
import { describePop3Error } from '../server/pop3/errors.js';
import { startFakePop3 } from './helpers/fakePop3.js';
import {
  WATCH,
  SAMPLE_CSV,
  LATIN1_CSV,
  alertEmail,
  alertEncodedSubject,
  alertLatin1,
  alertWithoutCsv,
  spoofedDisplayName,
  unrelatedEmail,
} from './fixtures/emails.js';

const USER = 'erwin.it@gracia.co.id';
const PASS = 'rahasia-Benar-123';

function memoryRepo({ failIngestOnce = false } = {}) {
  const messages = new Map();
  const ingested = [];
  const events = [];
  let failNext = failIngestOnce;
  return {
    messages,
    ingested,
    events,
    async getKnownUidls() {
      return new Map([...messages].map(([k, v]) => [k, { status: v.status, attempts: v.attempts }]));
    },
    async saveMessage({ uidl, status, headers }) {
      const prev = messages.get(uidl);
      messages.set(uidl, {
        status,
        subject: headers?.subject,
        attempts: (prev?.attempts || 0) + (status === 'error' ? 1 : 0),
      });
    },
    async ingest({ uidl, attachments }) {
      if (failNext) {
        failNext = false;
        throw new Error('simulasi gagal simpan');
      }
      ingested.push({ uidl, attachments });
      messages.set(uidl, { status: 'imported', attempts: 0 });
      return { reports: attachments.length, rows: 1, rowErrors: 0 };
    },
    async event(level, message, detail, uidl) {
      events.push({ level, message, detail, uidl });
    },
  };
}

const mailbox = () => [
  { uidl: 'u-news-1', raw: unrelatedEmail(1) },
  { uidl: 'u-alert-1', raw: alertEmail() },
  { uidl: 'u-spoof', raw: spoofedDisplayName() },
  { uidl: 'u-alert-2', raw: alertEncodedSubject() },
  { uidl: 'u-news-2', raw: unrelatedEmail(2) },
  { uidl: 'u-nocsv', raw: alertWithoutCsv() },
  { uidl: 'u-latin1', raw: alertLatin1() },
];

const clientFor = (srv, extra = {}) =>
  new SafePop3Client({ host: '127.0.0.1', port: srv.port, tls: false, username: USER, password: PASS, timeoutMs: 3000, ...extra });

test('TOP untuk semua email baru, RETR hanya yang cocok, DELE tidak pernah dikirim', async () => {
  const srv = await startFakePop3({ messages: mailbox(), user: USER, password: PASS });
  try {
    const repo = memoryRepo();
    const stats = await runFetch({ client: clientFor(srv), repo, watch: WATCH, secrets: [PASS] });

    assert.equal(stats.messagesTotal, 7);
    assert.equal(stats.messagesNew, 7);
    assert.equal(stats.messagesMatched, 4);
    assert.equal(stats.reportsImported, 3);
    assert.equal(stats.noCsv, 1);

    const tops = srv.commands.filter((c) => c.startsWith('TOP'));
    const retrs = srv.commands.filter((c) => c.startsWith('RETR'));
    assert.equal(tops.length, 7);
    assert.deepEqual(retrs, ['RETR 2', 'RETR 4', 'RETR 6', 'RETR 7']);
    assert.ok(!srv.commands.some((c) => /^DELE/i.test(c)), 'DELE tidak boleh dikirim');
    assert.equal(srv.commands.at(-1), 'QUIT');

    assert.equal(repo.messages.get('u-news-1').status, 'ignored');
    assert.equal(repo.messages.get('u-spoof').status, 'ignored');
    assert.equal(repo.messages.get('u-nocsv').status, 'no_csv');

    // Email cocok tanpa CSV harus tercatat sebagai peringatan, bukan dilewati diam-diam.
    const warn = repo.events.find((e) => e.uidl === 'u-nocsv');
    assert.equal(warn.level, 'warning');
    assert.match(warn.message, /tidak memiliki lampiran CSV/);

    // Lampiran utuh, termasuk lampiran 8bit Latin-1 dan baris yang diawali titik.
    const byUidl = Object.fromEntries(repo.ingested.map((i) => [i.uidl, i.attachments]));
    assert.deepEqual(byUidl['u-alert-1'][0].content, SAMPLE_CSV);
    assert.deepEqual(byUidl['u-latin1'][0].content.subarray(0, LATIN1_CSV.length - 2), LATIN1_CSV.subarray(0, -2));
  } finally {
    await srv.close();
  }
});

test('sinkronisasi kedua tidak mengunduh ulang email yang sudah tercatat (UIDL)', async () => {
  const srv = await startFakePop3({ messages: mailbox(), user: USER, password: PASS });
  try {
    const repo = memoryRepo();
    await runFetch({ client: clientFor(srv), repo, watch: WATCH });
    srv.commands.length = 0;

    const stats = await runFetch({ client: clientFor(srv), repo, watch: WATCH });
    assert.equal(stats.messagesNew, 0);
    assert.equal(repo.ingested.length, 3);
    assert.ok(!srv.commands.some((c) => /^(TOP|RETR|DELE)/.test(c)));
  } finally {
    await srv.close();
  }
});

test('email yang gagal diproses dicatat error lalu dicoba lagi berikutnya', async () => {
  const srv = await startFakePop3({ messages: [{ uidl: 'u-alert-1', raw: alertEmail() }], user: USER, password: PASS });
  try {
    const repo = memoryRepo({ failIngestOnce: true });
    const first = await runFetch({ client: clientFor(srv), repo, watch: WATCH });
    assert.equal(first.messageErrors, 1);
    assert.equal(repo.messages.get('u-alert-1').status, 'error');
    assert.equal(repo.events[0].level, 'error');

    const second = await runFetch({ client: clientFor(srv), repo, watch: WATCH });
    assert.equal(second.reportsImported, 1);
    assert.equal(repo.messages.get('u-alert-1').status, 'imported');
  } finally {
    await srv.close();
  }
});

test('password salah: pesan jelas dan password tidak bocor', async () => {
  const srv = await startFakePop3({ messages: [], user: USER, password: PASS });
  try {
    const wrong = 'PasswordSalah-999';
    const client = clientFor(srv, { password: wrong });
    const err = await client.stat().catch((e) => e);
    client.destroy();
    const info = describePop3Error(err, { host: '127.0.0.1', port: srv.port }, [wrong]);
    assert.equal(info.kind, 'AUTH_FAILED');
    assert.match(info.message, /username atau password/);
    assert.ok(!JSON.stringify(info).includes(wrong));
    assert.ok(srv.commands.includes('PASS ***'));
  } finally {
    await srv.close();
  }
});

test('mailbox terkunci sesi lain', async () => {
  const srv = await startFakePop3({ passError: '[IN-USE] Mailbox is locked by another session' });
  try {
    const err = await clientFor(srv).stat().catch((e) => e);
    assert.equal(describePop3Error(err).kind, 'MAILBOX_LOCKED');
  } finally {
    await srv.close();
  }
});

test('host tidak ditemukan', async () => {
  const client = new SafePop3Client({ host: 'tidak-ada.invalid', port: 995, tls: true, username: 'a', password: 'b', timeoutMs: 5000 });
  const err = await client.stat().catch((e) => e);
  const info = describePop3Error(err, { host: 'tidak-ada.invalid', port: 995 });
  assert.equal(info.kind, 'HOST_NOT_FOUND');
  assert.match(info.message, /tidak-ada\.invalid/);
});

test('port tertutup: koneksi ditolak', async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const err = await new SafePop3Client({ host: '127.0.0.1', port, tls: false, username: 'a', password: 'b' }).stat().catch((e) => e);
  assert.equal(describePop3Error(err, { host: '127.0.0.1', port }).kind, 'CONNECTION_REFUSED');
});

test('server diam: timeout', async () => {
  const srv = await startFakePop3({ silent: true });
  try {
    const client = clientFor(srv, { timeoutMs: 300 });
    const err = await client.stat().catch((e) => e);
    client.destroy();
    assert.equal(describePop3Error(err).kind, 'TIMEOUT');
  } finally {
    await srv.close();
  }
});

test('SSL/TLS aktif ke server tanpa SSL: masalah SSL', async () => {
  const srv = await startFakePop3({ messages: [] });
  try {
    const client = clientFor(srv, { tls: true, timeoutMs: 3000 });
    const err = await client.stat().catch((e) => e);
    client.destroy();
    assert.equal(describePop3Error(err).kind, 'TLS_MISMATCH');
  } finally {
    await srv.close();
  }
});

test('dot-unstuffing membuang titik tambahan di awal baris', () => {
  const out = dotUnstuff(Buffer.from('..awal\r\nbiasa\r\n..titik\r\n...dua\r\n'));
  assert.equal(out.toString(), '.awal\r\nbiasa\r\n.titik\r\n..dua\r\n');
});
