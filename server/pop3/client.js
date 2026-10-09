import net from 'node:net';
import Pop3Command from 'node-pop3';

const MAX_MAIL_BYTES = 30 * 1024 * 1024;

// Mailbox ini dipakai juga untuk keperluan lain: aplikasi hanya boleh MEMBACA.
// DELE diblokir di sini, dan SafePop3Client hanya membuka UIDL/TOP/RETR/STAT/QUIT.
class ReadOnlyPop3 extends Pop3Command {
  async DELE() {
    throw new Error('DELE diblokir: aplikasi ini hanya membaca mailbox.');
  }
}

export class Pop3TimeoutError extends Error {
  constructor(step, ms) {
    super(`Tidak ada respons dari server POP3 dalam ${Math.round(ms / 1000)} detik (${step}).`);
    this.code = 'ETIMEDOUT';
    this.eventName = 'timeout';
  }
}

export class SafePop3Client {
  constructor({ host, port, tls, username, password, allowInvalidCert = false, timeoutMs = 30000 }) {
    this.timeoutMs = timeoutMs;
    this.pop = new ReadOnlyPop3({
      host,
      port,
      tls,
      user: username,
      password,
      timeout: timeoutMs,
      parseStreamToString: false,
      // SNI hanya untuk nama host, bukan alamat IP (RFC 6066).
      tlsOptions: { rejectUnauthorized: !allowInvalidCert, ...(net.isIP(host) ? { servername: '' } : {}) },
    });
  }

  // Login dan ambil jumlah email (STAT). Dipakai juga untuk tombol "Tes koneksi".
  async stat() {
    const info = await this.#withTimeout('login', () => this.pop.STAT());
    const [count, size] = String(info).trim().split(/\s+/).map(Number);
    return { count: count || 0, size: size || 0 };
  }

  // [[nomorPesan, uidl], ...]
  async uidl() {
    const list = await this.#withTimeout('UIDL', () => this.pop.UIDL());
    return list.filter((parts) => parts.length >= 2).map(([num, uid]) => [Number(num), uid]);
  }

  // Hanya header (TOP n 0).
  async top(msgNum) {
    const buf = await this.#withTimeout(`TOP ${msgNum}`, async () =>
      readPop3Stream(await this.pop.TOP(msgNum, 0)),
    );
    return buf.toString('utf8');
  }

  // Email lengkap sebagai Buffer mentah (agar lampiran non-UTF-8 tidak rusak).
  async retr(msgNum) {
    return this.#withTimeout(`RETR ${msgNum}`, async () => readPop3Stream(await this.pop.RETR(msgNum)), 4);
  }

  async quit() {
    try {
      await this.#withTimeout('QUIT', () => this.pop.QUIT());
    } catch {
      this.destroy();
    }
  }

  destroy() {
    this.pop._socket?.destroy();
    this.pop._socket = null;
  }

  async #withTimeout(step, fn, factor = 1) {
    const ms = this.timeoutMs * factor;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.destroy();
        reject(new Pop3TimeoutError(step, ms));
      }, ms);
    });
    try {
      return await Promise.race([fn(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Membaca stream multi-line POP3 menjadi Buffer dan membalik byte-stuffing (RFC 1939 §3).
export function readPop3Stream(stream, maxBytes = MAX_MAIL_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    stream.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        stream.destroy();
        reject(new Error(`Email lebih besar dari ${Math.round(maxBytes / 1048576)} MB, dilewati.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(dotUnstuff(Buffer.concat(chunks, length))));
  });
}

export function dotUnstuff(buf) {
  const out = [];
  let start = 0;
  if (buf.length >= 2 && buf[0] === 0x2e && buf[1] === 0x2e) start = 1;
  for (let i = start; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x2e && buf[i + 3] === 0x2e) {
      out.push(buf.subarray(start, i + 3));
      start = i + 4;
      i = start - 1;
    }
  }
  if (start === 0) return buf;
  out.push(buf.subarray(start));
  return Buffer.concat(out);
}
