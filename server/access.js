import os from 'node:os';
import { config } from './config.js';

// Kontrol akses server.
// - Default (APP_HOST=127.0.0.1): hanya bisa dibuka dari komputer ini.
// - Mode LAN (APP_HOST=0.0.0.0): PC lain di jaringan boleh MELIHAT data (dan menekan
//   "Ambil email sekarang"), tetapi perubahan pengaturan/aturan hanya dari komputer server.
// Di kedua mode, permintaan dari situs lain (DNS rebinding / CSRF) ditolak lewat
// pemeriksaan Host & Origin, dan permintaan yang mengubah data wajib JSON.

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// Aksi yang mengubah data tetapi tetap boleh dari PC lain di jaringan.
const REMOTE_ALLOWED_WRITES = new Set(['POST /api/sync']);

export function isLoopback(addr) {
  return LOOPBACK_ADDRS.has(String(addr || ''));
}

export function hostnameOf(value) {
  try {
    return new URL(String(value).includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

let cache = { at: 0, hosts: null };

// Nama host yang sah untuk mengakses server: localhost, dan (mode LAN) alamat IP
// komputer ini, nama komputernya, serta APP_ALLOWED_HOSTS.
export function allowedHostnames() {
  if (!config.lanEnabled) return new Set(LOCAL_HOSTNAMES);
  if (cache.hosts && Date.now() - cache.at < 30_000) return cache.hosts;
  const hosts = new Set(LOCAL_HOSTNAMES);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      hosts.add(nic.family === 'IPv6' || nic.family === 6 ? `[${nic.address.split('%')[0]}]` : nic.address);
    }
  }
  const name = os.hostname().toLowerCase();
  hosts.add(name);
  hosts.add(`${name}.local`);
  for (const h of config.allowedHosts) hosts.add(h.toLowerCase());
  cache = { at: Date.now(), hosts };
  return hosts;
}

/**
 * Inti pemeriksaan (fungsi murni supaya mudah diuji).
 * @returns {null | {status: number, error: string}}
 */
export function checkAccess({ method, path, host, origin, remoteAddress, isJson }, { lanEnabled, hostnames }) {
  if (!hostnames.has(hostnameOf(host || ''))) {
    return {
      status: 403,
      error: lanEnabled
        ? `Alamat "${host}" tidak dikenal. Buka lewat alamat IP komputer server, atau tambahkan namanya ke APP_ALLOWED_HOSTS di .env.`
        : 'Akses hanya diizinkan dari komputer ini (localhost).',
    };
  }
  if (origin && !hostnames.has(hostnameOf(origin))) {
    return { status: 403, error: 'Permintaan dari situs lain ditolak.' };
  }
  if (!lanEnabled && !isLoopback(remoteAddress)) {
    return { status: 403, error: 'Akses hanya diizinkan dari komputer ini (localhost).' };
  }
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (writing && !isJson) {
    return { status: 415, error: 'Permintaan harus berformat JSON.' };
  }
  if (writing && !isLoopback(remoteAddress) && !REMOTE_ALLOWED_WRITES.has(`${method} ${path}`)) {
    return { status: 403, error: 'Perubahan hanya bisa dilakukan dari komputer server.' };
  }
  return null;
}

export function accessGuard(req, res, next) {
  const denied = checkAccess(
    {
      method: req.method,
      path: req.path,
      host: req.headers.host,
      origin: req.headers.origin,
      remoteAddress: req.socket.remoteAddress,
      isJson: Boolean(req.is('application/json')),
    },
    { lanEnabled: config.lanEnabled, hostnames: allowedHostnames() },
  );
  if (denied) return res.status(denied.status).json({ error: denied.error });
  next();
}

export function canEdit(req) {
  return isLoopback(req.socket.remoteAddress);
}

// Alamat yang bisa dibuka dari PC lain (untuk ditampilkan saat server mulai).
export function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      if ((nic.family === 'IPv4' || nic.family === 4) && !nic.internal) urls.push(`http://${nic.address}:${port}`);
    }
  }
  return urls;
}
