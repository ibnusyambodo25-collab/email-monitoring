import { useState } from 'react';
import { api, fmtDateTime, fmtDateTimeSec, fmtNum, fmtRelative, qs, useApi } from '../lib.js';

const RUN_STATUS = {
  running: ['Sedang berjalan', 'var(--accent)'],
  success: ['Berhasil', 'var(--status-good)'],
  partial: ['Sebagian berhasil', 'var(--status-warning)'],
  failed: ['Gagal', 'var(--status-critical)'],
};
const LEVEL = {
  info: ['Info', 'var(--accent)', 'i'],
  warning: ['Peringatan', 'var(--status-warning)', '!'],
  error: ['Error', 'var(--status-critical)', '✕'],
};

function StatusBadge({ status }) {
  const [label, color] = RUN_STATUS[status] || [status, 'var(--axis)'];
  return (
    <span className="badge">
      <span className="dot" style={{ background: color }} />
      {label}
    </span>
  );
}

export default function Status({ status, syncNow, dataTick }) {
  const [level, setLevel] = useState('');
  const [page, setPage] = useState(0);
  const [note, setNote] = useState(null);
  const s = status.data;
  const events = useApi(`/events${qs({ level, limit: 25, offset: page * 25 })}`, [dataTick, s?.running, s?.lastRun?.id]);
  const runs = useApi('/sync-runs?limit=10', [dataTick, s?.running]);
  const reports = useApi('/reports?limit=10', [dataTick]);
  const client = useApi('/client');
  const readOnly = client.data ? !client.data.canEdit : false;
  const onlyServer = readOnly ? 'Hanya bisa dari komputer server' : undefined;

  const action = async (path) => {
    try {
      const res = await api(path, { method: 'POST' });
      setNote(res.message);
      status.reload();
    } catch (err) {
      setNote(err.message);
    }
  };

  if (status.error && !s) {
    return (
      <div className="alert error">
        <span className="icon">✕</span>
        <div>{status.error}</div>
      </div>
    );
  }
  if (!s) return <div className="empty">Memuat…</div>;
  const lr = s.lastRun;

  return (
    <div className="stack">
      <div>
        <h1>Status</h1>
        <p className="subtitle">Kondisi pengambilan email dan catatan kejadian.</p>
      </div>

      <div className="grid cols-4">
        <div className="card">
          <div className="tile-label">Sinkronisasi terakhir</div>
          <div className="tile-value" style={{ fontSize: 20 }}>
            {lr ? fmtDateTime(lr.started_at) : 'Belum pernah'}
          </div>
          {lr && (
            <div className="tile-delta">
              <StatusBadge status={s.running ? 'running' : lr.status} /> {fmtRelative(lr.started_at)}
            </div>
          )}
        </div>
        <div className="card">
          <div className="tile-label">Terakhir berhasil</div>
          <div className="tile-value" style={{ fontSize: 20 }}>
            {s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : '–'}
          </div>
          <div className="tile-delta">
            {s.nextRunAt ? `Berikutnya otomatis: ${fmtDateTime(s.nextRunAt)}` : 'Pengambilan otomatis tidak aktif atau POP3 belum dikonfigurasi'}
          </div>
        </div>
        <div className="card">
          <div className="tile-label">Email report diproses</div>
          <div className="tile-value">{fmtNum(s.mailbox.imported)}</div>
          <div className="tile-delta">
            {fmtNum(s.totals.reports)} file CSV · {fmtNum(s.totals.rows)} baris · {fmtNum(s.mailbox.ignored)} email lain dilewati
          </div>
        </div>
        <div className="card">
          <div className="tile-label">Perlu perhatian</div>
          <div className="tile-value">{fmtNum(s.mailbox.noCsv + s.mailbox.error)}</div>
          <div className="tile-delta">
            {fmtNum(s.mailbox.noCsv)} tanpa lampiran CSV · {fmtNum(s.mailbox.error)} gagal diproses · {fmtNum(s.totals.parse_errors)} baris CSV gagal dibaca
          </div>
        </div>
      </div>

      <div className="row">
        <button className="btn primary" onClick={syncNow} disabled={s.running}>
          {s.running ? 'Sedang mengambil…' : 'Ambil email sekarang'}
        </button>
        <button className="btn" onClick={() => action('/mailbox/retry-failed')} disabled={readOnly} title={onlyServer || 'Email cocok yang gagal 5 kali dicoba lagi'}>
          Coba lagi email yang gagal
        </button>
        <button className="btn" onClick={() => action('/mailbox/rescan-ignored')} disabled={readOnly} title={onlyServer || 'Email yang sebelumnya dianggap tidak cocok diperiksa ulang'}>
          Periksa ulang email yang dilewati
        </button>
        {note && <span className="small muted">{note}</span>}
      </div>

      {lr?.status === 'failed' && !s.running && (
        <div className="alert error">
          <span className="icon">✕</span>
          <div>
            <strong>Sinkronisasi terakhir gagal.</strong> {lr.error_message}
          </div>
        </div>
      )}

      {s.problems.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Email report yang bermasalah</h2>
              <p>Email ini cocok dengan filter, tetapi datanya tidak bisa diimpor.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tanggal email</th>
                  <th>Subjek</th>
                  <th>Masalah</th>
                </tr>
              </thead>
              <tbody>
                {s.problems.map((p) => (
                  <tr key={p.uidl}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(p.email_date)}</td>
                    <td>{p.subject || '–'}</td>
                    <td className="small">
                      {p.status === 'no_csv'
                        ? 'Tidak ada lampiran CSV di email ini.'
                        : `Gagal diproses (${p.attempts}× dicoba${p.attempts >= 5 ? ', berhenti dicoba' : ''}): ${p.last_error || '-'}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Catatan kejadian</h2>
            <p>Klik “detail” untuk informasi teknis.</p>
          </div>
          <div className="seg" role="radiogroup" aria-label="Tingkat">
            {[['', 'Semua'], ['error', 'Error'], ['warning', 'Peringatan'], ['info', 'Info']].map(([k, l]) => (
              <button key={k} role="radio" aria-checked={level === k} className={level === k ? 'on' : ''} onClick={() => (setLevel(k), setPage(0))}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className={`loading-frame ${events.loading ? 'is-loading' : ''}`}>
          {events.data?.items.length ? (
            <table>
              <tbody>
                {events.data.items.map((e) => {
                  const [label, color, icon] = LEVEL[e.level];
                  return (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap', width: 1 }} className="small muted">
                        {fmtDateTimeSec(e.created_at)}
                      </td>
                      <td style={{ width: 1 }}>
                        <span className="badge" title={label}>
                          <span className="dot" style={{ background: color }} />
                          {icon} {label}
                        </span>
                      </td>
                      <td>
                        {e.message}
                        {e.detail && (
                          <details>
                            <summary className="small">detail</summary>
                            <pre className="reason">{e.detail}</pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty">Belum ada catatan.</div>
          )}
          {events.data && events.data.total > 25 && (
            <div className="pager">
              <span className="muted small">
                {fmtNum(page * 25 + 1)}–{fmtNum(Math.min((page + 1) * 25, events.data.total))} dari {fmtNum(events.data.total)}
              </span>
              <button className="btn small" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ‹ Lebih baru
              </button>
              <button className="btn small" disabled={(page + 1) * 25 >= events.data.total} onClick={() => setPage((p) => p + 1)}>
                Lebih lama ›
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Riwayat sinkronisasi</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Mulai</th>
                  <th>Status</th>
                  <th className="num">Email baru</th>
                  <th className="num">Report</th>
                  <th className="num">Baris</th>
                </tr>
              </thead>
              <tbody>
                {(runs.data || []).map((r) => (
                  <tr key={r.id} title={r.error_message || ''}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDateTime(r.started_at)} <span className="muted">({r.trigger === 'auto' ? 'otomatis' : 'manual'})</span>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="num">{fmtNum(r.messages_new)}</td>
                    <td className="num">{fmtNum(r.reports_imported)}</td>
                    <td className="num">
                      {fmtNum(r.rows_imported)}
                      {r.rows_failed ? <span className="muted small"> (+{r.rows_failed} gagal)</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {runs.data && !runs.data.length && <div className="empty">Belum ada sinkronisasi.</div>}
          </div>
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Report terbaru</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tanggal email</th>
                  <th className="num">Baris</th>
                  <th>File asli</th>
                </tr>
              </thead>
              <tbody>
                {(reports.data?.items || []).map((r) => (
                  <tr key={r.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDateTime(r.email_date || r.imported_at)}
                      {r.source === 'manual' && <span className="muted"> (impor manual)</span>}
                    </td>
                    <td className="num">
                      {fmtNum(r.row_count)}
                      {r.error_count ? <span className="small" style={{ color: 'var(--text-warning)' }}> ({r.error_count} gagal)</span> : null}
                    </td>
                    <td className="small">
                      <a href={`/api/reports/${r.id}/raw`} download>
                        {r.stored_path.split('/').pop()}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reports.data && !reports.data.items.length && <div className="empty">Belum ada report.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
