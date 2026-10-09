import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseReportCsv, detectDelimiter, parseWaktu, decodeCsvBuffer } from '../server/ingest/csv.js';
import { enrichRow, cleanReason, extractCodes, baseDomain, parseEximLine } from '../server/ingest/enrich.js';
import { SAMPLES_DIR, LATIN1_CSV } from './fixtures/emails.js';

const sample = (name) => fs.readFileSync(path.join(SAMPLES_DIR, name));

test('keempat sample asli terbaca tanpa error', async () => {
  const files = fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.csv'));
  assert.equal(files.length, 4);
  let total = 0;
  for (const f of files) {
    const res = await parseReportCsv(sample(f));
    assert.equal(res.fatal, null, f);
    assert.deepEqual(res.errors, [], f);
    assert.equal(res.delimiter, ',');
    assert.equal(res.encoding, 'utf-8');
    total += res.rows.length;
  }
  assert.equal(total, 9);
});

test('baris sample: waktu WIB, nomor baris, dan tanda kutip sisa dibersihkan', async () => {
  const { rows } = await parseReportCsv(sample('2026-10-08_09_rejected_email_hourly.csv'));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.lineNo), [2, 3, 4, 5]);
  assert.equal(rows[0].waktu, '2026-10-08T09:07:39+07:00');
  assert.equal(new Date(rows[0].waktu).toISOString(), '2026-10-08T02:07:39.000Z');
  assert.equal(rows[0].penyebab, 'No such person at this address."');
  assert.equal(cleanReason(rows[0].penyebab), 'No such person at this address.');
});

test('baris log Exim forward ke Gmail: penerima asli, tujuan forward, kode SMTP', async () => {
  const { rows } = await parseReportCsv(sample('2026-10-08_10_rejected_email_hourly.csv'));
  const r = enrichRow(rows[0]);
  assert.equal(rows[0].pengirim, '');
  assert.equal(r.recipient, 'sachroni_lesnawati@gracia.co.id');
  assert.equal(r.finalRecipient, 'office.fwd.jaypapi@gmail.com');
  assert.equal(r.direction, 'forward');
  assert.equal(r.smtpCode, '550');
  assert.equal(r.enhancedCode, '5.7.27');
  assert.equal(r.router, 'dkim_lookuphost');
  assert.equal(r.remoteHost, 'gmail-smtp-in.l.google.com');
  assert.ok(r.penyebabBersih.includes('\n550-5.7.27 for this message.'), '\\n literal jadi baris baru');

  const out = enrichRow(rows[1]);
  assert.equal(out.direction, 'outbound');
  assert.equal(out.sender, 'nita_busdevproduk@gracia.co.id');
  assert.equal(out.recipientDomain, 'ronnysatya.com');
});

test('baris Exim alias virtual: penerima diambil dari alamat asli', async () => {
  const { rows } = await parseReportCsv(sample('2026-10-08_09_rejected_email_hourly.csv'));
  const r = enrichRow(rows[3]);
  assert.equal(r.recipient, 'miraismiarty@gracia.co.id');
  assert.equal(r.finalRecipient, 'mira_ismiarty@gracia.co.id');
  assert.equal(r.router, 'virtual_aliases');
  assert.equal(r.direction, 'inbound');
  assert.equal(r.penyebabBersih.endsWith('No such person at this address.'), true);
});

test('arah email: inbound, internal, outbound', async () => {
  const { rows } = await parseReportCsv(sample('2026-10-08_09_rejected_email_hourly.csv'));
  assert.equal(enrichRow(rows[0]).direction, 'inbound');
  assert.equal(enrichRow(rows[2]).direction, 'internal');
  const probe = enrichRow({ pengirim: 'FA38DE@prd-bd-0DJ7AK.fastemailclean.com', penerima: 'a@gracia.co.id', penyebab: '' });
  assert.equal(probe.senderDomain, 'prd-bd-0dj7ak.fastemailclean.com');
  assert.equal(probe.senderBaseDomain, 'fastemailclean.com');
});

test('delimiter titik koma + encoding Latin-1', async () => {
  const res = await parseReportCsv(LATIN1_CSV);
  assert.equal(res.delimiter, ';');
  assert.equal(res.encoding, 'latin1');
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].pengirim, 'josé@contoh.es');
  assert.equal(res.rows[0].penerima, 'andré@gracia.co.id');
});

test('BOM UTF-8, CRLF, baris kosong di tengah dan di akhir dilewati', async () => {
  const csv = '﻿Waktu,Pengirim,Penerima,Penyebab\r\n\r\n"2026-10-08 01:00:00","a@x.com","b@gracia.co.id","No such person at this address."\r\n,,,\r\n\r\n';
  const res = await parseReportCsv(Buffer.from(csv, 'utf8'));
  assert.equal(res.fatal, null);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].lineNo, 3);
  assert.deepEqual(res.errors, []);
});

test('baris rusak dicatat dan tidak menghentikan baris lain', async () => {
  const csv = [
    'Waktu,Pengirim,Penerima,Penyebab',
    '"2026-10-08 01:00:00","a@x.com","b@gracia.co.id","OK satu"',
    '"bukan tanggal","a@x.com","b@gracia.co.id","waktu rusak"',
    '"2026-10-08 01:02:00","kolom kurang"',
    '"2026-10-08 01:03:00","a@x.com","b@gracia.co.id","Penyebab, dengan koma", tanpa kutip',
    '"2026-10-08 01:04:00","a@x.com","b@gracia.co.id","OK dua"',
    '',
  ].join('\n');
  const res = await parseReportCsv(Buffer.from(csv));
  assert.deepEqual(res.rows.map((r) => r.penyebab), ['OK satu', 'Penyebab, dengan koma, tanpa kutip', 'OK dua']);
  assert.equal(res.errors.length, 2);
  assert.match(res.errors[0].message, /Format Waktu/);
  assert.equal(res.errors[0].lineNo, 3);
  assert.match(res.errors[1].message, /kolom kurang/);
});

test('tanda kutip tidak tertutup di akhir file: baris sebelumnya tetap tersimpan', async () => {
  const csv = 'Waktu,Pengirim,Penerima,Penyebab\n"2026-10-08 01:00:00","a@x.com","b@gracia.co.id","OK"\n"2026-10-08 01:01:00","a@x.com","b@gracia.co.id","tidak ditutup\n';
  const res = await parseReportCsv(Buffer.from(csv));
  assert.equal(res.rows.length, 1);
  assert.equal(res.errors.length, 1);
});

test('Penyebab multi-baris (newline sungguhan di dalam kutip) tetap satu baris data', async () => {
  const csv = 'Waktu,Pengirim,Penerima,Penyebab\n"2026-10-08 01:00:00","a@x.com","b@gracia.co.id","550-5.1.1 baris satu\n550 5.1.1 baris dua"\n"2026-10-08 01:01:00","c@x.com","d@gracia.co.id","OK"\n';
  const res = await parseReportCsv(Buffer.from(csv));
  assert.equal(res.rows.length, 2);
  assert.deepEqual(res.rows.map((r) => r.lineNo), [2, 4]);
  assert.equal(extractCodes(res.rows[0].penyebab).enhancedCode, '5.1.1');
});

test('header tidak dikenal → fatal, file kosong → fatal', async () => {
  assert.match((await parseReportCsv(Buffer.from('a,b,c\n1,2,3\n'))).fatal, /Header CSV tidak dikenali/);
  assert.match((await parseReportCsv(Buffer.from(''))).fatal, /kosong/);
});

test('helper kecil', () => {
  assert.equal(detectDelimiter('"a;b",c,d\n'), ',');
  assert.equal(detectDelimiter('Waktu;Pengirim;Penerima;Penyebab'), ';');
  assert.equal(parseWaktu('2026-02-31 10:00:00'), null);
  assert.equal(parseWaktu('08/10/2026 9:05'), '2026-10-08T09:05:00+07:00');
  assert.equal(baseDomain('mail.kantor.co.id'), 'kantor.co.id');
  assert.equal(baseDomain('gmail.com'), 'gmail.com');
  assert.equal(decodeCsvBuffer(Buffer.from([0x63, 0xe9])).encoding, 'latin1');
  // IP di dalam [..] tidak boleh terbaca sebagai kode status.
  assert.deepEqual(extractCodes('H=x [10.2.5.7] : 421 timeout'), { smtpCode: null, enhancedCode: null });
  assert.equal(parseEximLine('The mail server could not deliver mail to a@b.com.'), null);
});
