import { parse } from 'csv-parse';
import iconv from 'iconv-lite';

// Parser report CSV yang toleran: delimiter koma/titik koma, UTF-8/Latin-1, baris kosong
// dilewati, dan baris rusak dicatat sebagai error tanpa menghentikan seluruh file.

const HEADER_ALIASES = {
  waktu: ['waktu', 'time', 'tanggal', 'date', 'datetime', 'timestamp'],
  pengirim: ['pengirim', 'from', 'sender'],
  penerima: ['penerima', 'to', 'recipient', 'rcpt'],
  penyebab: ['penyebab', 'alasan', 'reason', 'error', 'keterangan'],
};

const ERROR_TEXT = {
  CSV_INVALID_CLOSING_QUOTE: 'Tanda kutip penutup tidak berada di posisi yang benar',
  CSV_QUOTE_NOT_CLOSED: 'Tanda kutip tidak ditutup sampai akhir file',
  CSV_RECORD_INCONSISTENT_COLUMNS: 'Jumlah kolom tidak sesuai header',
  CSV_RECORD_INCONSISTENT_FIELDS_LENGTH: 'Jumlah kolom tidak sesuai header',
  CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: 'Ada karakter setelah tanda kutip penutup',
};

export function decodeCsvBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), 'utf16le'), encoding: 'utf-16le' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: iconv.decode(buf, 'latin1'), encoding: 'latin1' };
  }
}

// Delimiter ditebak dari baris pertama yang tidak kosong (header), di luar tanda kutip.
export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

// "2026-10-08 11:52:06" (waktu server, WIB) → ISO dengan offset +07:00.
export function parseWaktu(value) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  let y, mo, d, h, mi, se;
  if (m) [, y, mo, d, h, mi, se] = m;
  else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    [, d, mo, y, h, mi, se] = m;
  }
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${se || '00'}+07:00`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  // Tolak tanggal yang "meluber" (mis. 2026-02-31).
  const back = new Date(t.getTime() + 7 * 3600_000).toISOString();
  if (back.slice(0, 10) !== `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`) return null;
  return iso;
}

function mapHeader(header) {
  const idx = {};
  header.forEach((name, i) => {
    const key = String(name).trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (idx[field] === undefined && aliases.includes(key)) idx[field] = i;
    }
  });
  return idx;
}

function startLine(info, raw) {
  const inner = (raw || '').replace(/\r?\n$/, '').split('\n').length - 1;
  return info.lines - inner;
}

/**
 * @returns {Promise<{encoding, delimiter, rows: Array<{lineNo, waktu, pengirim, penerima, penyebab}>,
 *   errors: Array<{lineNo, raw, message}>, fatal: string|null}>}
 */
export async function parseReportCsv(buf) {
  const { text, encoding } = decodeCsvBuffer(buf);
  const delimiter = detectDelimiter(text);
  const rows = [];
  const errors = [];
  let skipped = [];
  let header = null;
  let idx = null;

  const flushSkipped = () => {
    // Satu record rusak bisa memicu beberapa event skip berturut-turut yang raw-nya
    // saling memperpanjang; yang dicatat hanya versi terakhir (terpanjang).
    const merged = [];
    for (const s of skipped) {
      const last = merged.at(-1);
      if (last && s.raw.startsWith(last.raw)) merged[merged.length - 1] = s;
      else merged.push(s);
    }
    for (const s of merged) {
      errors.push({
        lineNo: s.lines,
        raw: s.raw.replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
        message: ERROR_TEXT[s.code] || s.message,
      });
    }
    skipped = [];
  };

  const parser = parse(text, {
    delimiter,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    info: true,
    raw: true,
    on_skip: (err) => {
      if (err) skipped.push({ code: err.code, message: err.message, lines: err.lines, raw: err.raw || '' });
    },
  });

  let fatal = null;
  try {
    for await (const { record, info, raw } of parser) {
      flushSkipped();
      const lineNo = startLine(info, raw);
      if (!header) {
        header = record;
        idx = mapHeader(header);
        const missing = ['waktu', 'pengirim', 'penerima', 'penyebab'].filter((f) => idx[f] === undefined);
        if (missing.length) {
          fatal = `Header CSV tidak dikenali (kolom tidak ditemukan: ${missing.join(', ')}). Header: ${header.join(delimiter)}`;
          break;
        }
        continue;
      }
      if (record.every((v) => String(v).trim() === '')) continue;

      let fields = record;
      // Kolom berlebih (mis. koma tanpa tanda kutip di dalam Penyebab) digabung ke kolom terakhir.
      if (fields.length > header.length && idx.penyebab === header.length - 1) {
        fields = [...fields.slice(0, header.length - 1), fields.slice(header.length - 1).join(delimiter)];
      }
      const rawLine = String(raw || '').replace(/\r?\n$/, '');
      if (fields.length < header.length) {
        errors.push({ lineNo, raw: rawLine, message: `Jumlah kolom kurang (${fields.length} dari ${header.length})` });
        continue;
      }
      const waktu = parseWaktu(fields[idx.waktu]);
      if (!waktu) {
        errors.push({ lineNo, raw: rawLine, message: `Format Waktu tidak dikenali: "${fields[idx.waktu]}"` });
        continue;
      }
      rows.push({
        lineNo,
        waktu,
        pengirim: String(fields[idx.pengirim] ?? '').trim(),
        penerima: String(fields[idx.penerima] ?? '').trim(),
        penyebab: String(fields[idx.penyebab] ?? ''),
      });
    }
    flushSkipped();
  } catch (err) {
    flushSkipped();
    errors.push({ lineNo: err.lines ?? null, raw: null, message: ERROR_TEXT[err.code] || err.message });
  }

  if (!header && !fatal) fatal = 'File CSV kosong (tidak ada header).';
  return { encoding, delimiter, rows, errors, fatal };
}
