import { simpleParser } from 'mailparser';

// Header hasil TOP di-parse dengan mailparser, sehingga encoded-word (=?UTF-8?B?...?=)
// sudah ter-decode sebelum dicocokkan.
export async function parseHeaders(headerText) {
  const parsed = await simpleParser(headerText, { skipHtmlToText: true, skipTextToHtml: true });
  const from = parsed.from?.value?.[0];
  return {
    fromAddress: (from?.address || '').trim().toLowerCase(),
    fromName: from?.name || '',
    subject: parsed.subject || '',
    date: parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null,
    messageId: parsed.messageId || null,
  };
}

export function normalizeSubject(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Pengirim: dicocokkan dari ALAMAT email (bukan display name), tidak peka huruf besar/kecil.
// Subjek: cocok jika subjek email MEMUAT teks subjek yang diawasi (spasi dirapikan,
// tidak peka huruf besar/kecil), jadi tambahan seperti tanggal di ujung subjek tetap cocok.
export function matchesWatch(headers, { watchSender, watchSubject }) {
  const sender = String(watchSender || '').trim().toLowerCase();
  const subject = normalizeSubject(watchSubject);
  if (!sender || !subject) return false;
  return headers.fromAddress === sender && normalizeSubject(headers.subject).includes(subject);
}

export function isCsvAttachment(att) {
  const name = String(att.filename || '').toLowerCase();
  const type = String(att.contentType || '').toLowerCase();
  return (
    name.endsWith('.csv') ||
    type === 'text/csv' ||
    type === 'text/comma-separated-values' ||
    type === 'application/csv'
  );
}

export async function parseFullEmail(raw) {
  return simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
}

export function extractCsvAttachments(parsedMail) {
  return (parsedMail.attachments || []).filter(isCsvAttachment).map((att, i) => ({
    filename: att.filename || `lampiran_${i + 1}.csv`,
    contentType: att.contentType,
    content: att.content,
  }));
}
