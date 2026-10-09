// Contoh email buatan untuk pengujian (tanpa koneksi ke server email sungguhan).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = path.resolve(HERE, '..', '..', 'samples');

export const WATCH = {
  watchSender: 'root@srv.gracia.co.id',
  watchSubject: '[ALERT HOURLY] Ada Email Rejected/Gagal ke @gracia.co.id',
};

export const SAMPLE_CSV = fs.readFileSync(path.join(SAMPLES_DIR, '2026-10-08_09_rejected_email_hourly.csv'));

function b64lines(buf) {
  return Buffer.from(buf).toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function multipart({ from, subject, date, messageId, parts }) {
  const boundary = '----=_Part_FIXTURE';
  const head = [
    `From: ${from}`,
    'To: itsupport@gracia.co.id',
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    'This is a multi-part message in MIME format.',
  ].join('\r\n');
  const chunks = [Buffer.from(head + '\r\n')];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const textPart = {
  headers: ['Content-Type: text/plain; charset=UTF-8'],
  body: 'Terlampir daftar email rejected/gagal satu jam terakhir.\r\n.\r\nBaris di atas diawali titik untuk menguji dot-stuffing.',
};

export function alertEmail({ messageId = 'alert-1@srv.gracia.co.id', csv = SAMPLE_CSV, date = 'Thu, 08 Oct 2026 10:00:03 +0700' } = {}) {
  return multipart({
    from: 'root <root@srv.gracia.co.id>',
    subject: WATCH.watchSubject,
    date,
    messageId,
    parts: [
      textPart,
      {
        headers: [
          'Content-Type: text/csv; name="rejected_email_hourly.csv"',
          'Content-Transfer-Encoding: base64',
          'Content-Disposition: attachment; filename="rejected_email_hourly.csv"',
        ],
        body: b64lines(csv),
      },
    ],
  });
}

// Subjek dalam MIME encoded-word, alamat pengirim huruf besar, lampiran CSV tanpa nama
// file (hanya dikenali dari content-type).
export function alertEncodedSubject() {
  const encoded = `=?UTF-8?B?${Buffer.from(WATCH.watchSubject).toString('base64')}?=`;
  return multipart({
    from: '=?UTF-8?Q?Server_Gracia?= <ROOT@SRV.GRACIA.CO.ID>',
    subject: encoded,
    date: 'Thu, 08 Oct 2026 11:00:02 +0700',
    messageId: 'alert-2@srv.gracia.co.id',
    parts: [
      textPart,
      {
        headers: ['Content-Type: text/csv; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment'],
        body: b64lines(SAMPLE_CSV),
      },
    ],
  });
}

// Lampiran CSV Latin-1 dikirim 8bit (tidak di-base64) untuk memastikan byte mentah
// tidak rusak saat RETR.
export const LATIN1_CSV = Buffer.concat([
  Buffer.from('Waktu;Pengirim;Penerima;Penyebab\r\n', 'latin1'),
  Buffer.from('"2026-10-08 13:01:00";"jos\xe9@contoh.es";"andr\xe9@gracia.co.id";"No such person at this address."\r\n', 'latin1'),
]);

export function alertLatin1() {
  return multipart({
    from: 'root@srv.gracia.co.id',
    subject: WATCH.watchSubject,
    date: 'Thu, 08 Oct 2026 13:05:00 +0700',
    messageId: 'alert-latin1@srv.gracia.co.id',
    parts: [
      {
        headers: [
          'Content-Type: text/csv; charset=ISO-8859-1; name="rejected_email_hourly.csv"',
          'Content-Transfer-Encoding: 8bit',
          'Content-Disposition: attachment; filename="rejected_email_hourly.csv"',
        ],
        body: LATIN1_CSV,
      },
    ],
  });
}

export function alertWithoutCsv() {
  return multipart({
    from: 'root <root@srv.gracia.co.id>',
    subject: WATCH.watchSubject,
    date: 'Thu, 08 Oct 2026 12:00:01 +0700',
    messageId: 'alert-nocsv@srv.gracia.co.id',
    parts: [
      textPart,
      {
        headers: ['Content-Type: text/plain; name="catatan.txt"', 'Content-Disposition: attachment; filename="catatan.txt"'],
        body: 'bukan csv',
      },
    ],
  });
}

// Display name meniru alamat yang diawasi, tetapi alamat sebenarnya lain: TIDAK boleh cocok.
export function spoofedDisplayName() {
  return multipart({
    from: '"root@srv.gracia.co.id" <attacker@evil.example>',
    subject: WATCH.watchSubject,
    date: 'Thu, 08 Oct 2026 12:30:00 +0700',
    messageId: 'spoof@evil.example',
    parts: [
      {
        headers: ['Content-Type: text/csv; name="x.csv"', 'Content-Disposition: attachment; filename="x.csv"'],
        body: 'Waktu,Pengirim,Penerima,Penyebab\r\n',
      },
    ],
  });
}

export function unrelatedEmail(n = 1) {
  return Buffer.from(
    [
      'From: Newsletter <news@vendor.example>',
      'To: itsupport@gracia.co.id',
      `Subject: Promo bulan ini #${n}`,
      'Date: Thu, 08 Oct 2026 08:00:00 +0700',
      `Message-ID: <news-${n}@vendor.example>`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Isi newsletter yang besar dan tidak perlu diunduh.',
      '',
    ].join('\r\n'),
  );
}
