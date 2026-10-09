import { useMemo, useState } from 'react';
import FilterBar, { filterParams } from '../components/FilterBar.jsx';
import { Delta, StatTile, TopTable, TrendChart } from '../components/charts.jsx';
import { categoryColors, fmtBucket, fmtDateTime, fmtNum, qs, useApi } from '../lib.js';

const TOP_TABS = [
  ['recipient', 'Penerima'],
  ['sender', 'Pengirim'],
  ['sender_domain', 'Domain pengirim'],
  ['code', 'Kode error'],
  ['reason_text', 'Teks alasan'],
];

const NR_DIMS = [
  ['recipient', 'Penerima'],
  ['sender', 'Pengirim'],
  ['sender_domain', 'Domain pengirim'],
];

const STATUS_LABEL = { baru: 'Baru', berulang: 'Berulang', sesekali: 'Sesekali' };

// Filter Detail yang sesuai untuk tiap dimensi saat baris diklik.
function detailFilterFor(dimension, item) {
  switch (dimension) {
    case 'recipient':
      return { recipient: item.key, label: `Penerima: ${item.key}` };
    case 'sender':
      return { sender: item.key, label: `Pengirim: ${item.key}` };
    case 'sender_domain':
      return { sender_domain: item.key, label: `Domain pengirim: ${item.key}` };
    case 'code':
      return { q: item.key, label: `Kode: ${item.key}` };
    case 'category':
      return { category: item.key, label: `Kategori: ${item.category_label || item.key}` };
    default:
      return null;
  }
}

function Frame({ loading, children }) {
  return <div className={`loading-frame ${loading ? 'is-loading' : ''}`}>{children}</div>;
}

function ErrorLine({ error }) {
  return error ? (
    <div className="alert error" style={{ marginBottom: 12 }}>
      <span className="icon">✕</span>
      <div>{error}</div>
    </div>
  ) : null;
}

export default function Dashboard({ filters, setFilters, range, dataTick, openDetail }) {
  const [bucketPref, setBucketPref] = useState('auto');
  const [topDim, setTopDim] = useState('recipient');
  const [nrDim, setNrDim] = useState('recipient');
  const [nrStatus, setNrStatus] = useState('');
  const [nrPage, setNrPage] = useState(0);

  const hours = (range.to - range.from) / 3600_000;
  const bucket = bucketPref === 'auto' ? (hours <= 72 ? 'hour' : 'day') : bucketPref === 'hour' && hours > 62 * 24 ? 'day' : bucketPref;
  const base = filterParams(filters, range);
  const deps = [dataTick];

  const cats = useApi('/categories', deps);
  const colors = useMemo(() => categoryColors(cats.data || []), [cats.data]);
  const summary = useApi(`/analysis/summary${qs(base)}`, deps);
  const trend = useApi(`/analysis/trend${qs({ ...base, bucket })}`, deps);
  const spikes = useApi(`/analysis/spikes${qs({ ...base, bucket })}`, deps);
  const top = useApi(`/analysis/top${qs({ ...base, dimension: topDim, limit: 10 })}`, deps);
  const insights = useApi(`/analysis/insights${qs({ ...base, limit: 5 })}`, deps);
  const nr = useApi(`/analysis/new-recurring${qs({ ...base, dimension: nrDim, status: nrStatus, limit: 15, offset: nrPage * 15 })}`, deps);

  const s = summary.data?.current;
  const p = summary.data?.previous;
  const unitLabel = bucket === 'hour' ? 'per jam' : 'per hari';

  return (
    <div className="stack">
      <div>
        <h1>Dashboard</h1>
        <p className="subtitle">Email yang rejected/gagal terkirim, dari report per jam. Semua waktu dalam WIB.</p>
      </div>

      <FilterBar filters={filters} setFilters={setFilters}>
        <label>
          Tampilan
          <select value={bucketPref} onChange={(e) => setBucketPref(e.target.value)}>
            <option value="auto">Otomatis</option>
            <option value="hour">Per jam</option>
            <option value="day">Per hari</option>
          </select>
        </label>
      </FilterBar>

      <ErrorLine error={summary.error} />
      <Frame loading={summary.loading}>
        <div className="grid cols-4">
          <StatTile label="Total email gagal" value={s?.total} hero delta={s && <Delta current={s.total} previous={p?.total} />} />
          <StatTile label="Penerima berbeda" value={s?.unique_recipients} note={s && `${fmtNum(s.unique_sender_domains)} domain pengirim berbeda`} />
          <StatTile
            label="Masuk ke @gracia (gagal)"
            value={s?.inbound}
            note={s && `Lainnya: ${fmtNum(s.outbound)} keluar · ${fmtNum(s.forward)} forward · ${fmtNum(s.internal)} internal`}
          />
          <StatTile label="Dari pengecek email" value={s?.probe} note="percobaan alamat oleh layanan verifikasi, bukan email sungguhan" />
        </div>
      </Frame>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Tren email gagal {unitLabel}</h2>
            <p>Ditumpuk per kategori alasan. Tanda ⚠ = lonjakan dibanding rata-rata 7 hari sebelumnya.</p>
          </div>
        </div>
        <ErrorLine error={trend.error} />
        <Frame loading={trend.loading}>
          <TrendChart trend={trend.data} colors={colors} spikes={spikes.data?.items || []} />
        </Frame>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Paling sering muncul</h2>
              <p>Klik baris untuk melihat detailnya.</p>
            </div>
            <div className="seg" role="tablist">
              {TOP_TABS.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={topDim === k} className={topDim === k ? 'on' : ''} onClick={() => setTopDim(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <ErrorLine error={top.error} />
          <Frame loading={top.loading}>
            <TopTable
              items={top.data?.items}
              keyLabel={TOP_TABS.find(([k]) => k === topDim)[1]}
              showCategory={topDim !== 'reason_text'}
              onRowClick={detailFilterFor(topDim, { key: '' }) ? (it) => openDetail(detailFilterFor(topDim, it)) : undefined}
            />
          </Frame>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Alasan / kategori</h2>
                <p>Pengelompokan kolom Penyebab (aturannya bisa diubah di Pengaturan).</p>
              </div>
            </div>
            <Frame loading={summary.loading}>
              <CategoryBars categories={summary.data?.categories || []} total={s?.total || 0} colors={colors} onClick={(c) => openDetail(detailFilterFor('category', { key: c.code, category_label: c.label }))} />
            </Frame>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Lonjakan tidak biasa</h2>
                <p>
                  {spikes.data
                    ? `≥ ${spikes.data.thresholds.ratio}× rata-rata 7 hari sebelumnya${bucket === 'hour' ? ' pada jam yang sama' : ''} dan minimal ${spikes.data.thresholds.minCount} email.`
                    : ' '}
                </p>
              </div>
            </div>
            <Frame loading={spikes.loading}>
              {spikes.data?.items?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{bucket === 'hour' ? 'Jam (WIB)' : 'Tanggal'}</th>
                        <th className="num">Jumlah</th>
                        <th className="num">Rata-rata 7 hari</th>
                        <th className="num">{bucket === 'hour' ? 'Jam sebelumnya' : 'Hari sebelumnya'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spikes.data.items.map((it) => (
                        <tr
                          key={it.bucket}
                          className="clickable"
                          tabIndex={0}
                          onClick={() => openSpike(it)}
                          onKeyDown={(e) => e.key === 'Enter' && openSpike(it)}
                        >
                          <td>⚠ {fmtBucket(it.bucket, bucket)}</td>
                          <td className="num">
                            <strong>{fmtNum(it.n)}</strong> {it.ratio ? <span className="muted small">({it.ratio}×)</span> : null}
                          </td>
                          <td className="num">{it.baseline.toLocaleString('id-ID')}</td>
                          <td className="num">{fmtNum(it.prev_n)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">
                  Tidak ada lonjakan pada rentang ini.
                  {spikes.data?.evaluableFrom && new Date(spikes.data.evaluableFrom) > range.from && (
                    <div className="small" style={{ marginTop: 6 }}>
                      Lonjakan baru bisa dinilai setelah ada riwayat 7 hari (mulai {fmtDateTime(spikes.data.evaluableFrom)}).
                    </div>
                  )}
                </div>
              )}
            </Frame>
          </div>
        </div>
      </div>

      <div>
        <h2 style={{ marginBottom: 4 }}>Temuan yang perlu ditindaklanjuti</h2>
        <p className="subtitle">Ringkasan otomatis dari rentang dan filter di atas.</p>
        <ErrorLine error={insights.error} />
        <Frame loading={insights.loading}>
          <div className="grid cols-2">
            <InsightCard
              title="Forward mailbox ditolak"
              hint="Mailbox @gracia yang diteruskan (mis. ke Gmail) tetapi ditolak, biasanya karena SPF. Perbaiki atau hentikan forwarding-nya."
              items={insights.data?.forwardFailures}
              onPick={(it) => openDetail({ recipient: it.key, direction: 'forward', label: `Forward gagal: ${it.key}` })}
            />
            <InsightCard
              title="Alamat @gracia tidak ada, tetapi terus dikirimi"
              hint="Bisa karyawan yang sudah keluar, salah ketik, atau alamat lama. Pertimbangkan alias/forward bila alamatnya penting."
              items={insights.data?.missingMailboxes}
              onPick={(it) => openDetail({ recipient: it.key, label: `Penerima: ${it.key}` })}
            />
            <InsightCard
              title="Staf gagal mengirim keluar"
              hint="Pengirim internal yang emailnya gagal ke luar (domain/akun tujuan tidak ada, ditolak, dsb.)."
              items={insights.data?.outboundFailures}
              onPick={(it) => openDetail({ sender: it.key, direction: 'outbound', label: `Pengirim: ${it.key}` })}
            />
            <InsightCard
              title="Alamat yang dicoba layanan pengecek"
              hint="Layanan verifikasi email mencoba-coba variasi alamat. Biasanya aman diabaikan."
              items={insights.data?.probedRecipients}
              onPick={(it) => openDetail({ recipient: it.key, probe: 'only', label: `Dicoba pengecek: ${it.key}` })}
            />
          </div>
        </Frame>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>Baru vs berulang</h2>
            <p>
              Baru = pertama kali muncul di rentang ini. Berulang = sudah muncul di ≥ {nr.data?.recurringMinDays ?? 3} hari berbeda.
              Sesekali = sisanya.
            </p>
          </div>
          <div className="row">
            <select value={nrDim} onChange={(e) => (setNrDim(e.target.value), setNrPage(0))} aria-label="Dimensi">
              {NR_DIMS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <div className="seg" role="radiogroup" aria-label="Status">
              {[['', 'Semua'], ['baru', 'Baru'], ['berulang', 'Berulang'], ['sesekali', 'Sesekali']].map(([k, l]) => (
                <button key={k} role="radio" aria-checked={nrStatus === k} className={nrStatus === k ? 'on' : ''} onClick={() => (setNrStatus(k), setNrPage(0))}>
                  {l}
                  {k && nr.data ? ` (${fmtNum(nr.data.counts[k])})` : ''}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ErrorLine error={nr.error} />
        <Frame loading={nr.loading}>
          {nr.data?.items?.length ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{NR_DIMS.find(([k]) => k === nrDim)[1]}</th>
                      <th>Status</th>
                      <th className="num">Di rentang ini</th>
                      <th className="num">Total sepanjang data</th>
                      <th className="num">Jumlah hari</th>
                      <th>Pertama</th>
                      <th>Terakhir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nr.data.items.map((it) => (
                      <tr
                        key={it.key}
                        className="clickable"
                        tabIndex={0}
                        onClick={() => openDetail(detailFilterFor(nrDim, it))}
                        onKeyDown={(e) => e.key === 'Enter' && openDetail(detailFilterFor(nrDim, it))}
                      >
                        <td className="key">{it.key}</td>
                        <td>
                          <span className="badge">{STATUS_LABEL[it.status]}</span>
                        </td>
                        <td className="num">{fmtNum(it.n)}</td>
                        <td className="num">{fmtNum(it.total_all)}</td>
                        <td className="num">{fmtNum(it.days_seen)}</td>
                        <td className="small muted">{fmtDateTime(it.first_seen)}</td>
                        <td className="small muted">{fmtDateTime(it.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <span className="muted small">
                  {fmtNum(nrPage * 15 + 1)}–{fmtNum(Math.min((nrPage + 1) * 15, nr.data.total))} dari {fmtNum(nr.data.total)}
                </span>
                <button className="btn small" disabled={nrPage === 0} onClick={() => setNrPage((x) => x - 1)}>
                  ‹ Sebelumnya
                </button>
                <button className="btn small" disabled={(nrPage + 1) * 15 >= nr.data.total} onClick={() => setNrPage((x) => x + 1)}>
                  Berikutnya ›
                </button>
              </div>
            </>
          ) : (
            <div className="empty">Tidak ada data.</div>
          )}
        </Frame>
      </div>
    </div>
  );

  function openSpike(it) {
    const from = new Date(it.bucket_start);
    const to = new Date(from.getTime() + (bucket === 'hour' ? 3600_000 : 86400_000));
    openDetail({ from: from.toISOString(), to: to.toISOString(), label: `Lonjakan ${fmtBucket(it.bucket, bucket)}` });
  }
}

function CategoryBars({ categories, total, colors, onClick }) {
  if (!categories.length) return <div className="empty">Tidak ada data.</div>;
  const max = Math.max(...categories.map((c) => c.n));
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {categories.map((c) => (
            <tr key={c.code} className="clickable" tabIndex={0} onClick={() => onClick(c)} onKeyDown={(e) => e.key === 'Enter' && onClick(c)}>
              <td style={{ width: '48%' }}>
                <span className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <i className="swatch" style={{ background: colors.get(c.code).color, marginTop: 4 }} />
                  {c.label}
                </span>
              </td>
              <td>
                <div className="inline-bar" style={{ width: `${(c.n / max) * 100}%`, background: colors.get(c.code).color }} />
              </td>
              <td className="num">
                <strong>{fmtNum(c.n)}</strong> <span className="muted small">{total ? Math.round((c.n / total) * 100) : 0}%</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsightCard({ title, hint, items, onPick }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        {hint}
      </p>
      {items?.length ? (
        <table>
          <tbody>
            {items.map((it) => (
              <tr key={it.key} className="clickable" tabIndex={0} onClick={() => onPick(it)} onKeyDown={(e) => e.key === 'Enter' && onPick(it)}>
                <td className="key">{it.key}</td>
                <td className="num">
                  <strong>{fmtNum(it.n)}</strong>×
                </td>
                <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                  terakhir {fmtDateTime(it.last_seen)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted small">Tidak ada.</div>
      )}
    </div>
  );
}
