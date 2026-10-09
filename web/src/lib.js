import { useCallback, useEffect, useRef, useState } from 'react';

// ---------- API ----------

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Tidak bisa menghubungi server aplikasi. Pastikan server berjalan (npm run dev atau npm start).');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* bukan JSON */
  }
  if (!res.ok) throw new Error(data?.error || `Server membalas dengan status ${res.status}.`);
  return data;
}

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, v instanceof Date ? v.toISOString() : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// Mengambil data; saat memuat ulang, data lama tetap ditampilkan (tidak berkedip).
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return undefined;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    api(path, { signal: ctrl.signal })
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((err) => {
        if (err.name !== 'AbortError') setState((s) => ({ ...s, error: err.message, loading: false }));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

// ---------- Routing sederhana berbasis hash ----------

export function useHashRoute() {
  const get = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  const [route, setRoute] = useState(get);
  useEffect(() => {
    const on = () => setRoute(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (route) => {
  window.location.hash = `#/${route}`;
};

// ---------- Penyimpanan preferensi (boleh gagal) ----------

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* abaikan */
  }
}

// ---------- Tanggal (Asia/Jakarta, UTC+7 tanpa DST) ----------

const TZ = 'Asia/Jakarta';

export function jakartaYmd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const startOfJakartaDay = (ymd) => new Date(`${ymd}T00:00:00+07:00`);
export const addDaysYmd = (ymd, n) => jakartaYmd(new Date(startOfJakartaDay(ymd).getTime() + n * 86400_000 + 3600_000));

export const PRESETS = [
  { key: '24h', label: '24 jam' },
  { key: 'today', label: 'Hari ini' },
  { key: '7d', label: '7 hari' },
  { key: '30d', label: '30 hari' },
  { key: '90d', label: '90 hari' },
  { key: 'custom', label: 'Pilih tanggal' },
];

// Rentang [from, to). "now" dibulatkan ke menit berikutnya supaya stabil.
export function computeRange(f, now = new Date()) {
  const end = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  const today = jakartaYmd(now);
  switch (f.preset) {
    case '24h':
      return { from: new Date(end.getTime() - 24 * 3600_000), to: end };
    case 'today':
      return { from: startOfJakartaDay(today), to: end };
    case '30d':
      return { from: startOfJakartaDay(addDaysYmd(today, -29)), to: end };
    case '90d':
      return { from: startOfJakartaDay(addDaysYmd(today, -89)), to: end };
    case 'custom': {
      const a = f.fromDate || today;
      const b = f.toDate && f.toDate >= a ? f.toDate : a;
      return { from: startOfJakartaDay(a), to: startOfJakartaDay(addDaysYmd(b, 1)) };
    }
    default:
      return { from: startOfJakartaDay(addDaysYmd(today, -6)), to: end };
  }
}

// ---------- Format ----------

const nf = new Intl.NumberFormat('id-ID');
export const fmtNum = (n) => (n === null || n === undefined ? '–' : nf.format(n));

const dtf = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dtfSec = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const df = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });

export const fmtDateTime = (v) => (v ? `${dtf.format(new Date(v))}` : '–');
export const fmtDateTimeSec = (v) => (v ? `${dtfSec.format(new Date(v))}` : '–');
export const fmtDate = (v) => (v ? df.format(new Date(v)) : '–');

export function fmtRelative(v) {
  if (!v) return '–';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  const abs = Math.abs(diff);
  const unit = abs < 60 ? [Math.round(abs), 'detik'] : abs < 3600 ? [Math.round(abs / 60), 'menit'] : abs < 86400 ? [Math.round(abs / 3600), 'jam'] : [Math.round(abs / 86400), 'hari'];
  return diff >= 0 ? `${unit[0]} ${unit[1]} lalu` : `${unit[0]} ${unit[1]} lagi`;
}

// Label sumbu: "08 Okt 09:00" (per jam) atau "08 Okt" (per hari), dari bucket lokal "YYYY-MM-DDTHH:mm".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function fmtBucket(bucket, unit) {
  const [d, t] = bucket.split('T');
  const [, m, day] = d.split('-');
  const base = `${day} ${MONTHS[Number(m) - 1]}`;
  return unit === 'hour' ? `${base} ${t}` : base;
}

export const DIRECTION_LABELS = {
  inbound: 'Masuk',
  outbound: 'Keluar',
  internal: 'Internal',
  forward: 'Forward',
  unknown: 'Tidak diketahui',
};

// ---------- Warna kategori: tetap per kategori (bukan per peringkat) ----------
// 7 kategori pertama (urutan sort_order) mendapat slot warna 1–7; sisanya dan
// "other" dilipat ke "Lainnya" (abu-abu).

export const OTHER_KEY = '__lainnya';

export function categoryColors(categories = []) {
  const named = categories.filter((c) => c.code !== 'other').slice(0, 7);
  const map = new Map(named.map((c, i) => [c.code, { color: `var(--series-${i + 1})`, label: c.label, order: i }]));
  return {
    get(code) {
      return map.get(code) || { color: 'var(--series-other)', label: 'Lainnya', order: 99, folded: true };
    },
    keyOf(code) {
      return map.has(code) ? code : OTHER_KEY;
    },
  };
}
