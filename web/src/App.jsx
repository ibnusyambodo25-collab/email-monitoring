import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, computeRange, fmtRelative, loadPref, savePref, useApi, useHashRoute, useInterval } from './lib.js';
import Dashboard from './pages/Dashboard.jsx';
import Detail from './pages/Detail.jsx';
import Settings from './pages/Settings.jsx';
import Status from './pages/Status.jsx';

const NAV = [
  ['dashboard', 'Dashboard'],
  ['detail', 'Detail'],
  ['pengaturan', 'Pengaturan'],
  ['status', 'Status'],
];

const DEFAULT_FILTERS = { preset: '7d', fromDate: '', toDate: '', direction: '', category: '', probe: 'all' };

export default function App() {
  const route = useHashRoute();
  const [filters, setFiltersState] = useState(() => loadPref('rmm.filters', DEFAULT_FILTERS));
  // Filter tambahan khusus halaman Detail (diisi saat klik baris di Dashboard).
  const [detailFilters, setDetailFilters] = useState({});
  const [dataTick, setDataTick] = useState(0);
  const [syncMsg, setSyncMsg] = useState(null);

  const setFilters = useCallback((patch) => {
    setFiltersState((f) => {
      const next = { ...f, ...patch };
      savePref('rmm.filters', next);
      return next;
    });
  }, []);

  // Rentang dihitung ulang saat filter berubah, data diperbarui, atau tiap 5 menit.
  const [clock, setClock] = useState(0);
  useInterval(() => setClock((c) => c + 1), 5 * 60_000);
  const range = useMemo(() => computeRange(filters), [filters, dataTick, clock]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = useApi('/status');
  const running = status.data?.running;
  useInterval(status.reload, running ? 2000 : 30_000);

  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (running) setWasRunning(true);
    else if (wasRunning && status.data) {
      setWasRunning(false);
      const lr = status.data.lastRun;
      setSyncMsg(
        lr?.status === 'failed'
          ? { kind: 'error', text: lr.error_message }
          : { kind: lr?.status === 'partial' ? 'warning' : 'ok', text: `Selesai: ${lr?.reports_imported ?? 0} report baru, ${lr?.rows_imported ?? 0} baris.` },
      );
      setDataTick((t) => t + 1);
    }
  }, [running, wasRunning, status.data]);

  const syncNow = async () => {
    setSyncMsg(null);
    try {
      await api('/sync', { method: 'POST' });
      setWasRunning(true);
      status.reload();
    } catch (err) {
      setSyncMsg({ kind: 'error', text: err.message });
    }
  };

  const openDetail = (extra) => {
    setDetailFilters(extra);
    window.location.hash = '#/detail';
  };

  const lastOk = status.data?.lastSuccessAt;
  const ctx = { filters, setFilters, range, dataTick, openDetail, refreshAll: () => setDataTick((t) => t + 1) };

  return (
    <>
      <header className="topbar">
        <div className="brand">Monitor Email Rejected</div>
        <nav className="nav">
          {NAV.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={route === key ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        <div className="sync-chip" title="Waktu sinkronisasi berhasil terakhir">
          {running ? (
            <span className="badge">
              <span className="dot" style={{ background: 'var(--accent)' }} /> Mengambil email…
            </span>
          ) : (
            <span>Sinkron terakhir: {lastOk ? fmtRelative(lastOk) : 'belum pernah'}</span>
          )}
          <button className="btn primary" onClick={syncNow} disabled={running}>
            Ambil email sekarang
          </button>
        </div>
      </header>
      <main>
        {syncMsg && (
          <div className={`alert ${syncMsg.kind}`} style={{ marginBottom: 16 }} role="status">
            <span className="icon">{syncMsg.kind === 'ok' ? '✓' : syncMsg.kind === 'warning' ? '!' : '✕'}</span>
            <div style={{ flex: 1 }}>{syncMsg.text}</div>
            <button className="btn small" onClick={() => setSyncMsg(null)} aria-label="Tutup pesan">
              Tutup
            </button>
          </div>
        )}
        {route === 'dashboard' && <Dashboard {...ctx} />}
        {route === 'detail' && <Detail {...ctx} extra={detailFilters} setExtra={setDetailFilters} />}
        {route === 'pengaturan' && <Settings onSaved={ctx.refreshAll} />}
        {route === 'status' && <Status status={status} syncNow={syncNow} dataTick={dataTick} />}
      </main>
    </>
  );
}
