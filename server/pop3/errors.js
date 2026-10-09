// Menerjemahkan error koneksi POP3 menjadi pesan yang bisa dipahami orang non-teknis.
// Pesan TIDAK PERNAH memuat password; detail teknis disaring dengan redact().

const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
]);

export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 1) out = out.split(String(s)).join('***');
  }
  return out;
}

export function isConnectionLevelError(err) {
  const ev = err?.eventName;
  return (
    ev === 'timeout' ||
    ev === 'close' ||
    ev === 'end' ||
    ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED'].includes(err?.code) ||
    err?.message === 'no-socket'
  );
}

export function describePop3Error(err, { host = '', port = '', tls = true } = {}, secrets = []) {
  const code = err?.code || '';
  const msg = String(err?.message || '');
  const cmd = String(err?.command || '');
  const where = `${host}:${port}`;
  const detail = redact([code, err?.eventName, cmd && `perintah ${cmd}`, msg].filter(Boolean).join(' | '), secrets);

  const result = (kind, message) => ({ kind, message, detail });
  // Balasan "-ERR ..." dari server (node-pop3 menyertakan perintah yang ditolak).
  const serverReply = err?.command !== undefined;

  if (serverReply && /\[IN-USE\]|\block(ed)?\b|in use|busy/i.test(msg)) {
    return result(
      'MAILBOX_LOCKED',
      'Mailbox sedang dipakai sesi lain (misalnya Outlook sedang mengambil email). POP3 hanya mengizinkan satu sesi sekaligus. Coba lagi beberapa menit lagi.',
    );
  }
  if (serverReply && /plaintext|non-secure|unencrypted|STLS|STARTTLS|privacy/i.test(msg)) {
    return result(
      'TLS_REQUIRED',
      'Server menolak login tanpa enkripsi. Aktifkan SSL/TLS dan gunakan port 995.',
    );
  }
  if (serverReply && (/^(USER|PASS)\b/.test(cmd) || /\[AUTH\]|authenticat|password|login|credential|invalid user/i.test(msg))) {
    return result('AUTH_FAILED', 'Login ditolak server: username atau password POP3 salah.');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') {
    return result(
      'HOST_NOT_FOUND',
      `Server "${host}" tidak ditemukan. Periksa penulisan nama server dan koneksi jaringan/DNS komputer ini.`,
    );
  }
  if (code === 'ECONNREFUSED') {
    return result(
      'CONNECTION_REFUSED',
      `Koneksi ke ${where} ditolak. Periksa nomor port (biasanya 995 untuk SSL/TLS, 110 tanpa SSL) dan firewall.`,
    );
  }
  if (TLS_CERT_CODES.has(code) || /certificate/i.test(msg)) {
    return result(
      'TLS_CERTIFICATE',
      `Sertifikat SSL server ${host} tidak dipercaya (${code || 'sertifikat tidak valid'}). ` +
        'Pastikan nama server sama dengan nama di sertifikat. Jika server internal memang memakai sertifikat sendiri, aktifkan opsi "Izinkan sertifikat tidak valid" di Pengaturan.',
    );
  }
  if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO' || /wrong version number|ssl|tls/i.test(msg)) {
    return result(
      'TLS_MISMATCH',
      `Gagal membuat koneksi SSL/TLS ke ${where}. Kemungkinan port ini tidak memakai SSL langsung. ` +
        'Cocokkan pengaturan: port 995 dengan SSL/TLS aktif, atau port 110 tanpa SSL.',
    );
  }
  if (code === 'ETIMEDOUT' || err?.eventName === 'timeout') {
    return result(
      'TIMEOUT',
      `Server ${where} tidak merespons (timeout). Periksa koneksi jaringan, firewall, dan pastikan pilihan SSL/TLS sesuai port ` +
        '(port 995 harus dengan SSL/TLS aktif).',
    );
  }
  if (err?.eventName === 'close' || err?.eventName === 'end' || code === 'ECONNRESET' || msg === 'no-socket') {
    return result(
      'CONNECTION_CLOSED',
      `Koneksi ke ${where} terputus oleh server. Coba lagi; jika terus terjadi, periksa pengaturan SSL/TLS dan port.`,
    );
  }
  if (err?.eventName === 'bad-server-response') {
    return result(
      'BAD_RESPONSE',
      `Server ${where} membalas dengan format yang tidak dikenal. Pastikan ini server POP3 dan pengaturan SSL/TLS sesuai port.`,
    );
  }
  if (serverReply && msg) {
    return result('SERVER_ERROR', `Server POP3 menolak permintaan: ${redact(msg, secrets)}`);
  }
  return result('UNKNOWN', `Terjadi kesalahan saat menghubungi server POP3: ${redact(msg || code || 'tidak diketahui', secrets)}`);
}
