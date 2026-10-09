import { Fragment, useEffect, useState } from 'react';
import FilterBar, { filterParams } from '../components/FilterBar.jsx';
import { DIRECTION_LABELS, fmtDateTime, fmtDateTimeSec, fmtNum, qs, useApi } from '../lib.js';

const COLUMNS = [
  ['waktu', 'Waktu (WIB)'],
  ['pengirim', 'Pengirim'],
  ['penerima', 'Penerima'],
  ['arah', 'Arah'],
  ['kategori', 'Kategori'],
];

export default function Detail({ filters, setFilters, range, dataTick, extra, setExtra }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState({ col: 'waktu', order: 'desc' });
  const [open, setOpen] = useState(null);

  // Pencarian dikirim setelah berhenti mengetik sebentar.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [filters, extra]);

  const { label, ...extraParams } = extra || {};
  const params = {
    ...filterParams(filters, range),
    ...extraParams,
    q: q || extraParams.q,
  };
  const list = useApi(`/rejections${qs({ ...params, page, pageSize, sort: sort.col, order: sort.order })}`, [dataTick]);
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportUrl = (format) => `/api/rejections/export${qs({ ...params, format })}`;

  const toggleSort = (col) =>
    setSort((s) => ({ col, order: s.col === col && s.order === 'desc' ? 'asc' : 'desc' }));

  return (
    <div className="stack">
      <div>
        <h1>Detail</h1>
        <p className="subtitle">Semua baris dari report, dengan pencarian, filter, dan ekspor.</p>
      </div>
      <FilterBar filters={filters} setFilters={setFilters}>
        <input
          type="search"
          placeholder="Cari alamat, alasan, kode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240, flex: 1 }}
          aria-label="Cari"
        />
      </FilterBar>

      {label && (
        <div className="row">
          <span className="badge">
            Filter tambahan: {label}
            {extraParams.from && ` (${fmtDateTime(extraParams.from)} – ${fmtDateTime(extraParams.to)})`}
          </span>
          <button className="btn small" onClick={() => setExtra({})}>
            Hapus filter tambahan
          </button>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>{data ? `${fmtNum(data.total)} baris` : 'Memuat…'}</h2>
            <p>Klik baris untuk melihat alasan lengkap dan asal report.</p>
          </div>
          <div className="row">
            <a className="btn" href={exportUrl('csv')} download>
              Ekspor CSV
            </a>
            <a className="btn" href={exportUrl('xlsx')} download>
              Ekspor Excel
            </a>
          </div>
        </div>
        {list.error && (
          <div className="alert error">
            <span className="icon">✕</span>
            <div>{list.error}</div>
          </div>
        )}
        <div className={`loading-frame ${list.loading ? 'is-loading' : ''}`}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map(([col, title]) => (
                    <th
                      key={col}
                      className="sortable"
                      onClick={() => toggleSort(col)}
                      aria-sort={sort.col === col ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      {title} {sort.col === col ? (sort.order === 'asc' ? '▲' : '▼') : ''}
                    </th>
                  ))}
                  <th>Penyebab</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className="clickable"
                      tabIndex={0}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.id ? null : r.id)}
                      aria-expanded={open === r.id}
                    >
                      <td style={{ whiteSpace: 'nowrap' }}>{r.waktu_wib}</td>
                      <td className="key">{r.pengirim || <span className="muted">(kosong)</span>}</td>
                      <td className="key">
                        {r.penerima || (r.recipient ? <span title="Dibaca dari kolom Penyebab">{r.recipient}*</span> : <span className="muted">(kosong)</span>)}
                      </td>
                      <td>
                        {DIRECTION_LABELS[r.direction]}
                        {r.is_probe && (
                          <>
                            {' '}
                            <span className="badge">pengecek</span>
                          </>
                        )}
                      </td>
                      <td className="small">{r.reason_label}</td>
                      <td className="small" style={{ minWidth: 260 }}>
                        <span className="truncate">{r.penyebab_bersih}</span>
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                          <RowDetail r={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {data && !data.items.length && <div className="empty">Tidak ada baris yang cocok dengan filter.</div>}
          </div>
          <div className="pager">
            <label className="small muted">
              Baris per halaman{' '}
              <select value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))}>
                {[25, 50, 100, 200].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <span className="muted small">
              Halaman {fmtNum(page)} dari {fmtNum(pages)}
            </span>
            <button className="btn small" disabled={page <= 1} onClick={() => setPage(1)}>
              « Awal
            </button>
            <button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ‹ Sebelumnya
            </button>
            <button className="btn small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Berikutnya ›
            </button>
          </div>
        </div>
      </div>
      <p className="small muted">* Penerima yang kosong di report dibaca dari isi kolom Penyebab (log server email).</p>
    </div>
  );
}

function RowDetail({ r }) {
  const facts = [
    ['Waktu', fmtDateTimeSec(r.waktu)],
    ['Penerima (terbaca)', r.recipient],
    ['Tujuan forward/alias', r.final_recipient],
    ['Kode SMTP', [r.smtp_code, r.enhanced_code].filter(Boolean).join(' / ')],
    ['Router / host', [r.router, r.remote_host].filter(Boolean).join(' · ')],
    ['Report', `${r.original_filename} (email ${fmtDateTime(r.email_date)}, baris ${r.line_no})`],
  ].filter(([, v]) => v);
  return (
    <div className="stack" style={{ padding: 4 }}>
      <pre className="reason">{r.penyebab_bersih}</pre>
      <div className="row small" style={{ gap: '4px 20px' }}>
        {facts.map(([k, v]) => (
          <span key={k}>
            <span className="muted">{k}:</span> {v}
          </span>
        ))}
        <a href={`/api/reports/${r.report_id}/raw`} download>
          Unduh file CSV asli
        </a>
      </div>
    </div>
  );
}
