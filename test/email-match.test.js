import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeaders, matchesWatch, parseFullEmail, extractCsvAttachments } from '../server/pop3/match.js';
import {
  WATCH,
  SAMPLE_CSV,
  alertEmail,
  alertEncodedSubject,
  alertWithoutCsv,
  spoofedDisplayName,
  unrelatedEmail,
} from './fixtures/emails.js';

const headersOf = (buf) => {
  const i = buf.indexOf('\r\n\r\n');
  return parseHeaders(buf.subarray(0, i + 4).toString('utf8'));
};

test('email alert normal cocok dengan filter default', async () => {
  const h = await headersOf(alertEmail());
  assert.equal(h.fromAddress, 'root@srv.gracia.co.id');
  assert.equal(h.subject, WATCH.watchSubject);
  assert.ok(matchesWatch(h, WATCH));
});

test('subjek encoded-word di-decode dan alamat huruf besar tetap cocok', async () => {
  const h = await headersOf(alertEncodedSubject());
  assert.equal(h.subject, WATCH.watchSubject);
  assert.equal(h.fromAddress, 'root@srv.gracia.co.id');
  assert.equal(h.fromName, 'Server Gracia');
  assert.ok(matchesWatch(h, WATCH));
});

test('display name yang meniru alamat pengirim TIDAK cocok', async () => {
  const h = await headersOf(spoofedDisplayName());
  assert.equal(h.fromAddress, 'attacker@evil.example');
  assert.equal(matchesWatch(h, WATCH), false);
});

test('email lain tidak cocok', async () => {
  const h = await headersOf(unrelatedEmail());
  assert.equal(matchesWatch(h, WATCH), false);
});

test('subjek dengan tambahan teks dan spasi berbeda tetap cocok; subjek lain tidak', () => {
  const base = { fromAddress: 'root@srv.gracia.co.id' };
  assert.ok(matchesWatch({ ...base, subject: 'FW:  [ALERT HOURLY]  Ada Email Rejected/Gagal ke @gracia.co.id 08-10-2026' }, WATCH));
  assert.ok(matchesWatch({ ...base, subject: '[alert hourly] ada email rejected/gagal ke @GRACIA.co.id' }, WATCH));
  assert.equal(matchesWatch({ ...base, subject: '[ALERT DAILY] Ada Email Rejected/Gagal ke @gracia.co.id' }, WATCH), false);
  assert.equal(matchesWatch({ fromAddress: 'root@srv2.gracia.co.id', subject: WATCH.watchSubject }, WATCH), false);
});

test('filter yang kosong tidak mencocokkan apa pun', () => {
  const h = { fromAddress: 'root@srv.gracia.co.id', subject: WATCH.watchSubject };
  assert.equal(matchesWatch(h, { watchSender: '', watchSubject: WATCH.watchSubject }), false);
  assert.equal(matchesWatch(h, { watchSender: WATCH.watchSender, watchSubject: '  ' }), false);
});

test('lampiran CSV diambil berdasarkan ekstensi .csv', async () => {
  const atts = extractCsvAttachments(await parseFullEmail(alertEmail()));
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, 'rejected_email_hourly.csv');
  assert.deepEqual(atts[0].content, SAMPLE_CSV);
});

test('lampiran CSV tanpa nama file dikenali dari content-type text/csv', async () => {
  const atts = extractCsvAttachments(await parseFullEmail(alertEncodedSubject()));
  assert.equal(atts.length, 1);
  assert.match(atts[0].filename, /\.csv$/);
  assert.deepEqual(atts[0].content, SAMPLE_CSV);
});

test('email cocok tanpa lampiran CSV menghasilkan daftar kosong', async () => {
  const atts = extractCsvAttachments(await parseFullEmail(alertWithoutCsv()));
  assert.equal(atts.length, 0);
});
