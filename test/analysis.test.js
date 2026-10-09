// Test analisis SQL dengan data sintetis yang hasilnya bisa dihitung manual.
import { hasDb, resetTestDb } from './helpers/testDb.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const opts = { skip: hasDb ? false : 'DATABASE_URL belum diisi di .env' };
let pool, q;

const FWD =
  'office.fwd.jaypapi@gmail.com <sachroni_lesnawati@gracia.co.id> R=dkim_lookuphost T=dkim_remote_smtp H=gmail-smtp-in.l.google.com [142.251.12.27] : SMTP error from remote mail server after end of data: 550-5.7.27 Your email has been blocked because SPF authentication didn\'t pass';
const row = (t, from, to, why = 'No such person at this address."') =>
  [t, from, to, why].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');

// Data (WIB):
//  1–7 Okt 09:30  lama@gracia.co.id (1 baris/hari)        → berulang, baseline jam 09 = 1
//  3 Okt 13:00    kadang@gracia.co.id                      → muncul lagi 8 Okt: 2 hari = sesekali
//  8 Okt 09:05–09:14 baru@gracia.co.id ×10 dari bulk@spam.example
//  8 Okt 09:20, 09:21 forward SPF sachroni → gmail ×2
//  8 Okt 09:30    lama@gracia.co.id                        → jam 09 total 13 = LONJAKAN
//  8 Okt 10:15    keluar: nita → ronnysatya.com
//  8 Okt 11:52/53 probe fastemailclean & bounceprevention
//  8 Okt 13:00    kadang@gracia.co.id
function buildReports() {
  const head = 'Waktu,Pengirim,Penerima,Penyebab';
  const reports = [];
  for (let d = 1; d <= 7; d++) {
    const rows = [row(`2026-10-0${d} 09:30:00`, 'spammer@x.com', 'lama@gracia.co.id')];
    if (d === 3) rows.push(row('2026-10-03 13:00:00', 'teman@contoh.com', 'kadang@gracia.co.id'));
    reports.push([head, ...rows].join('\n'));
  }
  const day8 = [head];
  for (let m = 5; m <= 14; m++) day8.push(row(`2026-10-08 09:${String(m).padStart(2, '0')}:00`, 'bulk@spam.example', 'baru@gracia.co.id'));
  day8.push(row('2026-10-08 09:20:00', '', '', FWD), row('2026-10-08 09:21:00', '', '', FWD));
  day8.push(row('2026-10-08 09:30:00', 'spammer@x.com', 'lama@gracia.co.id'));
  day8.push(
    row(
      '2026-10-08 10:15:00',
      'nita_busdevproduk@gracia.co.id',
      'enggalperdana@ronnysatya.com',
      'The mail server could not deliver mail to enggalperdana@ronnysatya.com.  The account or domain may not exist, they may be blacklisted, or missing the proper dns entries.',
    ),
  );
  day8.push(row('2026-10-08 11:52:06', 'FA38DE@prd-bd-0DJ7AK.fastemailclean.com', 'siti_aropah@gracia.co.id'));
  day8.push(row('2026-10-08 11:53:16', 'BC7I64@prd-bd-BPVYKR.bounceprevention.com', 'aropahsiti@gracia.co.id'));
  day8.push(row('2026-10-08 13:00:00', 'teman@contoh.com', 'kadang@gracia.co.id'));
  reports.push(day8.join('\n'));
  return reports;
}

const DAY8 = { from: '2026-10-08T00:00:00+07:00', to: '2026-10-09T00:00:00+07:00' };

before(async () => {
  if (!hasDb) return;
  pool = await resetTestDb();
  const { withTransaction } = await import('../server/db/pool.js');
  const { ingestAttachment } = await import('../server/ingest/ingest.js');
  for (const [i, csv] of buildReports().entries()) {
    await withTransaction((db) =>
      ingestAttachment(db, {
        source: 'manual',
        emailDate: new Date(`2026-10-0${i + 1}T23:00:00+07:00`),
        filename: `r${i + 1}.csv`,
        content: Buffer.from(csv),
        internalDomain: 'gracia.co.id',
      }),
    );
  }
  q = await import('../server/analysis/queries.js');
});

after(async () => {
  await pool?.end();
});

test('ringkasan: total, arah, probe, dan pembanding periode sebelumnya', opts, async () => {
  const s = await q.summary(DAY8);
  assert.equal(s.current.total, 17);
  assert.equal(s.current.forward, 2);
  assert.equal(s.current.outbound, 1);
  assert.equal(s.current.inbound, 14);
  assert.equal(s.current.probe, 2);
  assert.equal(s.previous.total, 1); // 7 Okt
  const cats = Object.fromEntries(s.categories.map((c) => [c.code, c.n]));
  assert.deepEqual(cats, { no_such_user: 14, spf_dmarc_fail: 2, remote_not_exist: 1 });
});

test('filter: sembunyikan probe dan pencarian teks', opts, async () => {
  assert.equal((await q.summary({ ...DAY8, probe: 'exclude' })).current.total, 15);
  assert.equal((await q.summary({ ...DAY8, q: 'GMAIL.com' })).current.total, 2);
  assert.equal((await q.summary({ ...DAY8, q: '100%_' })).current.total, 0);
});

test('tren per jam: 24 titik, jam 09 = 13 dengan rincian kategori', opts, async () => {
  const t = await q.trend({ ...DAY8, bucket: 'hour' });
  assert.equal(t.points.length, 24);
  assert.equal(t.points.reduce((a, p) => a + p.total, 0), 17);
  const h9 = t.points.find((p) => p.bucket === '2026-10-08T09:00');
  assert.equal(h9.total, 13);
  assert.deepEqual(h9.by_category, { no_such_user: 11, spf_dmarc_fail: 2 });
  assert.equal(new Date(h9.bucket_start).toISOString(), '2026-10-08T02:00:00.000Z');
});

test('tren per hari: titik kosong tetap muncul (nol)', opts, async () => {
  const t = await q.trend({ from: '2026-10-01T00:00:00+07:00', to: '2026-10-10T00:00:00+07:00', bucket: 'day' });
  assert.deepEqual(
    t.points.map((p) => p.total),
    [1, 1, 2, 1, 1, 1, 1, 17, 0],
  );
});

test('top-N penerima, domain pengirim, dan kategori', opts, async () => {
  const r = await q.top({ ...DAY8, dimension: 'recipient', limit: 3 });
  assert.equal(r.items[0].key, 'baru@gracia.co.id');
  assert.equal(r.items[0].n, 10);
  assert.equal(r.items[1].key, 'sachroni_lesnawati@gracia.co.id');
  assert.equal(r.items[1].top_category, 'spf_dmarc_fail');

  const d = await q.top({ ...DAY8, dimension: 'sender_domain' });
  assert.deepEqual(d.items.slice(0, 2).map((i) => [i.key, i.n]), [['spam.example', 10], ['bounceprevention.com', 1]]);

  const c = await q.top({ ...DAY8, dimension: 'category' });
  assert.equal(c.items[0].category_label, 'Alamat penerima tidak ada');

  const rt = await q.top({ ...DAY8, dimension: 'reason_text' });
  assert.ok(rt.items.some((i) => i.key.startsWith('<alamat> <alamat> R=dkim_lookuphost') && i.key.includes('[ip]') && i.n === 2));
});

test('lonjakan per jam: hanya jam 09 (13 vs rata-rata 1)', opts, async () => {
  const s = await q.spikes({ ...DAY8, bucket: 'hour' });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].bucket, '2026-10-08T09:00');
  assert.equal(s.items[0].n, 13);
  assert.equal(s.items[0].baseline, 1);
  assert.equal(s.items[0].prev_n, 0);
  assert.deepEqual(s.thresholds, { ratio: 2, minCount: 5 });
});

test('lonjakan per hari: 8 Okt (17 vs rata-rata 8/7)', opts, async () => {
  const s = await q.spikes({ ...DAY8, bucket: 'day' });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].n, 17);
  assert.equal(s.items[0].baseline, 1.14);
  assert.equal(s.items[0].prev_n, 1);
});

test('baru vs berulang vs sesekali', opts, async () => {
  const r = await q.newVsRecurring({ ...DAY8, dimension: 'recipient', limit: 50 });
  assert.deepEqual(r.counts, { baru: 5, berulang: 1, sesekali: 1 });
  const st = Object.fromEntries(r.items.map((i) => [i.key, i.status]));
  assert.equal(st['baru@gracia.co.id'], 'baru');
  assert.equal(st['lama@gracia.co.id'], 'berulang');
  assert.equal(st['kadang@gracia.co.id'], 'sesekali');
  const lama = r.items.find((i) => i.key === 'lama@gracia.co.id');
  assert.equal(lama.days_seen, 8);

  const only = await q.newVsRecurring({ ...DAY8, dimension: 'recipient', status: 'berulang' });
  assert.equal(only.total, 1);
  assert.equal(only.items.length, 1);
});

test('temuan: forward gagal, mailbox tidak ada, kirim keluar gagal, probe', opts, async () => {
  const i = await q.insights(DAY8);
  assert.deepEqual(i.forwardFailures.map((x) => [x.key, x.n]), [['sachroni_lesnawati@gracia.co.id', 2]]);
  assert.deepEqual(i.missingMailboxes.map((x) => x.key), ['baru@gracia.co.id', 'kadang@gracia.co.id', 'lama@gracia.co.id']);
  assert.deepEqual(i.outboundFailures.map((x) => x.key), ['nita_busdevproduk@gracia.co.id']);
  assert.equal(i.probedRecipients.length, 2);
});

test('validasi parameter', opts, async () => {
  await assert.rejects(q.trend({ from: '2026-01-01', to: '2026-10-01', bucket: 'hour' }), /terlalu panjang/);
  await assert.rejects(q.top({ ...DAY8, dimension: 'drop table' }), /dimension tidak dikenal/);
  await assert.rejects(q.summary({ from: '2026-10-09', to: '2026-10-08' }), /sebelum/);
  await assert.rejects(q.summary({ from: 'kemarin' }), /tanggal yang valid/);
});
