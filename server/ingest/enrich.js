// Kolom turunan dari satu baris report: alamat efektif, domain, arah, kode SMTP, dll.
// Kategori alasan dan penanda "probe" dihitung di PostgreSQL (classify_rejections),
// supaya aturan bisa diubah dari GUI tanpa mengubah kode.

const EMAIL_RE = /^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]+$/;

// Sufiks domain dua tingkat yang umum, agar "a.b.co.id" → "b.co.id", bukan "co.id".
const SECOND_LEVEL = new Set([
  'co.id', 'ac.id', 'go.id', 'or.id', 'web.id', 'my.id', 'biz.id', 'sch.id', 'net.id', 'mil.id', 'ponpes.id', 'desa.id',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'com.sg', 'edu.sg', 'com.my', 'co.jp', 'ne.jp',
  'com.cn', 'co.in', 'com.br', 'co.kr', 'com.hk', 'com.tw', 'co.nz', 'co.za', 'com.ph', 'co.th', 'com.vn',
]);

export function normalizeEmail(value) {
  const s = String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}

export function domainOf(email) {
  return email ? email.slice(email.lastIndexOf('@') + 1) : null;
}

export function baseDomain(domain) {
  if (!domain) return null;
  const labels = domain.split('.');
  if (labels.length <= 2) return domain;
  const last2 = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(last2) ? labels.slice(-3).join('.') : last2;
}

// Membersihkan teks Penyebab untuk ditampilkan/diklasifikasi:
// - "\n" literal (backslash + n) diubah jadi baris baru sungguhan
// - tanda kutip sisa di ujung (contoh: `address."`) dibuang bila jumlah kutip ganjil
export function cleanReason(text) {
  let s = String(text || '').replace(/\\r\\n|\\n|\\r/g, '\n');
  const quotes = (s.match(/"/g) || []).length;
  if (quotes % 2 === 1 && s.trimEnd().endsWith('"')) s = s.trimEnd().slice(0, -1);
  return s.trim();
}

// Baris log Exim di Penyebab, contoh:
//   office.fwd.x@gmail.com <user@gracia.co.id> R=dkim_lookuphost T=... H=host [ip] ...: SMTP error ... 550-5.7.27 ...
//   a@gracia.co.id (b@gracia.co.id) <b@gracia.co.id> R=virtual_aliases : No such person at this address.
const EXIM_RE = /^\s*(\S+@\S+?)(?:\s+\(([^)]*)\))?(?:\s+<([^>]*)>)?(?=\s+(?:R=|T=|:))/;

export function parseEximLine(reason) {
  const m = String(reason || '').match(EXIM_RE);
  if (!m) return null;
  return {
    finalAddress: normalizeEmail(m[1]),
    originalAddress: normalizeEmail(m[3]) || normalizeEmail((m[2] || '').split(/[\s,]+/).at(-1)),
    router: reason.match(/\bR=(\S+)/)?.[1] || null,
    remoteHost: reason.match(/\bH=(\S+)/)?.[1] || null,
  };
}

export function extractCodes(reason) {
  const s = String(reason || '');
  const pair = s.match(/(?<![\d.])([245]\d\d)[ -]([245]\.\d{1,3}\.\d{1,3})(?![\d]|\.\d)/);
  if (pair) return { smtpCode: pair[1], enhancedCode: pair[2] };
  const enhanced = s.match(/(?<![\d.])([245]\.\d{1,3}\.\d{1,3})(?![\d]|\.\d)/)?.[1] || null;
  const smtp = s.match(/SMTP error[^:]*:\s*([245]\d\d)\b/i)?.[1] || null;
  return { smtpCode: smtp, enhancedCode: enhanced };
}

export function isInternal(email, internalDomain) {
  const d = domainOf(email);
  if (!d || !internalDomain) return false;
  const base = internalDomain.toLowerCase();
  return d === base || d.endsWith(`.${base}`);
}

export function enrichRow(row, { internalDomain = 'gracia.co.id' } = {}) {
  const penyebabBersih = cleanReason(row.penyebab);
  const exim = parseEximLine(penyebabBersih);

  const sender = normalizeEmail(row.pengirim);
  let recipient = normalizeEmail(row.penerima);
  let finalRecipient = null;
  if (exim) {
    if (!recipient) recipient = exim.originalAddress || exim.finalAddress;
    if (exim.finalAddress && exim.finalAddress !== recipient) finalRecipient = exim.finalAddress;
  }

  const sInt = sender ? isInternal(sender, internalDomain) : null;
  const rInt = recipient ? isInternal(recipient, internalDomain) : null;
  let direction = 'unknown';
  if (finalRecipient && rInt && !isInternal(finalRecipient, internalDomain)) direction = 'forward';
  else if (sender && recipient) direction = sInt && rInt ? 'internal' : sInt ? 'outbound' : rInt ? 'inbound' : 'unknown';
  else if (recipient) direction = rInt ? 'inbound' : 'outbound';

  const senderDomain = domainOf(sender);
  const { smtpCode, enhancedCode } = extractCodes(penyebabBersih);
  return {
    ...row,
    penyebabBersih,
    sender,
    senderDomain,
    senderBaseDomain: baseDomain(senderDomain),
    recipient,
    recipientDomain: domainOf(recipient),
    finalRecipient,
    direction,
    smtpCode,
    enhancedCode,
    router: exim?.router || null,
    remoteHost: exim?.remoteHost || null,
  };
}
