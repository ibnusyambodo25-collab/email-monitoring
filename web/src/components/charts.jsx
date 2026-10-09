import { useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { OTHER_KEY, fmtBucket, fmtDateTime, fmtNum } from '../lib.js';

export function StatTile({ label, value, hero = false, delta, note }) {
  return (
    <div className="card">
      <div className="tile-label">{label}</div>
      <div className={`tile-value ${hero ? 'hero' : ''}`}>{fmtNum(value)}</div>
      {delta}
      {note && <div className="tile-delta">{note}</div>}
    </div>
  );
}

// Selisih terhadap periode sebelumnya. Naik = lebih banyak email gagal = buruk.
export function Delta({ current, previous }) {
  if (previous === undefined || previous === null) return null;
  const diff = current - previous;
  if (diff === 0) return <div className="tile-delta">Sama dengan periode sebelumnya ({fmtNum(previous)})</div>;
  const pct = previous > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / previous) * 100)}%)` : '';
  return (
    <div className="tile-delta">
      <span className={diff > 0 ? 'up' : 'down'}>
        {diff > 0 ? '▲ naik' : '▼ turun'} {fmtNum(Math.abs(diff))}
        {pct}
      </span>{' '}
      dibanding periode sebelumnya ({fmtNum(previous)})
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.key}>
          {it.line ? <i className="line-key" style={{ background: it.color }} /> : <i className="swatch" style={{ background: it.color }} />}
          {it.label}
        </span>
      ))}
    </div>
  );
}

function TrendTooltip({ active, payload, unit, series, maLabel }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <div className="t-title">
        {fmtBucket(row.bucket, unit)}
        {unit === 'hour' ? ' WIB' : ''}
      </div>
      <div className="t-row">
        <strong>{fmtNum(row.total)}</strong> total
      </div>
      {series
        .filter((s) => row[s.key] > 0)
        .map((s) => (
          <div className="t-row" key={s.key}>
            <strong>{fmtNum(row[s.key])}</strong>
            <i className="swatch" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      <div className="t-row">
        <strong>{row.ma?.toLocaleString('id-ID', { maximumFractionDigits: 1 })}</strong>
        <i className="line-key" style={{ background: 'var(--series-line)' }} />
        {maLabel}
      </div>
      {row.spike && <div className="t-row" style={{ marginTop: 4 }}>⚠ Lonjakan: {row.spike.ratio ? `${row.spike.ratio}× rata-rata` : 'di atas ambang'}</div>}
    </div>
  );
}

// Tren jumlah email gagal per jam/hari, ditumpuk per kategori alasan.
export function TrendChart({ trend, colors, spikes = [] }) {
  const [asTable, setAsTable] = useState(false);
  const unit = trend?.bucket || 'hour';
  const maLabel = `Rata-rata bergerak ${trend?.movingAvgWindow ?? ''} ${unit === 'hour' ? 'jam' : 'hari'}`;

  const { rows, series } = useMemo(() => {
    const spikeMap = new Map(spikes.map((s) => [s.bucket, s]));
    const sums = new Map();
    const rows = (trend?.points || []).map((p) => {
      const r = { bucket: p.bucket, total: p.total, ma: p.moving_avg, spike: spikeMap.get(p.bucket) };
      for (const [code, n] of Object.entries(p.by_category || {})) {
        const key = colors.keyOf(code);
        r[key] = (r[key] || 0) + n;
        sums.set(key, (sums.get(key) || 0) + n);
      }
      return r;
    });
    const series = [...sums.keys()]
      .map((key) => {
        const c = key === OTHER_KEY ? colors.get('other') : colors.get(key);
        return { key, color: c.color, label: c.label, order: c.order };
      })
      .sort((a, b) => a.order - b.order);
    return { rows, series };
  }, [trend, colors, spikes]);

  if (!trend) return <div className="empty">Memuat…</div>;
  const legend = [...series, { key: 'ma', label: maLabel, color: 'var(--series-line)', line: true }];

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Legend items={legend} />
        <button className="btn small" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Lihat grafik' : 'Lihat tabel'}
        </button>
      </div>
      {asTable ? (
        <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>{unit === 'hour' ? 'Jam (WIB)' : 'Tanggal'}</th>
                <th className="num">Total</th>
                {series.map((s) => (
                  <th className="num" key={s.key}>
                    {s.label}
                  </th>
                ))}
                <th className="num">{maLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.total > 0)
                .map((r) => (
                  <tr key={r.bucket}>
                    <td>
                      {fmtBucket(r.bucket, unit)} {r.spike && <span className="badge">⚠ lonjakan</span>}
                    </td>
                    <td className="num">{fmtNum(r.total)}</td>
                    {series.map((s) => (
                      <td className="num" key={s.key}>
                        {fmtNum(r[s.key] || 0)}
                      </td>
                    ))}
                    <td className="num">{r.ma?.toLocaleString('id-ID', { maximumFractionDigits: 1 })}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!rows.some((r) => r.total > 0) && <div className="empty">Tidak ada data pada rentang ini.</div>}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={rows} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} barCategoryGap={1}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="bucket"
              tickFormatter={(b) => fmtBucket(b, unit)}
              stroke="var(--axis)"
              tickLine={false}
              minTickGap={28}
              interval="preserveStartEnd"
            />
            <YAxis allowDecimals={false} stroke="var(--axis)" tickLine={false} axisLine={false} width={40} tickFormatter={fmtNum} />
            <Tooltip
              cursor={{ fill: 'var(--accent-wash)' }}
              content={<TrendTooltip unit={unit} series={series} maLabel={maLabel} />}
              isAnimationActive={false}
            />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} stroke="var(--surface-1)" strokeWidth={1} maxBarSize={24} isAnimationActive={false} />
            ))}
            <Line type="monotone" dataKey="ma" stroke="var(--series-line)" strokeWidth={2} dot={false} isAnimationActive={false} />
            {spikes.map((s) => (
              <ReferenceLine
                key={s.bucket}
                x={s.bucket}
                stroke="var(--status-serious)"
                strokeWidth={1}
                label={{ value: '⚠', position: 'top', fill: 'var(--text-secondary)', fontSize: 12 }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// Tabel peringkat dengan batang kecil satu warna (besaran), bukan warna per baris.
export function TopTable({ items = [], keyLabel = 'Nama', onRowClick, showCategory = true, emptyText = 'Tidak ada data.' }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  if (!items.length) return <div className="empty">{emptyText}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th className="num">Jumlah</th>
            <th style={{ width: '18%' }} aria-hidden="true" />
            <th className="num" title="Jumlah hari berbeda dalam rentang">
              Hari
            </th>
            {showCategory && <th>Alasan terbanyak</th>}
            <th>Terakhir</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr
              key={it.key}
              className={onRowClick ? 'clickable' : ''}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(it) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(it) : undefined}
              title={onRowClick ? 'Lihat baris-baris ini di halaman Detail' : undefined}
            >
              <td className="key">{it.category_label || it.key}</td>
              <td className="num">
                <strong>{fmtNum(it.n)}</strong> <span className="muted small">{it.share}%</span>
              </td>
              <td>
                <div className="inline-bar" style={{ width: `${(it.n / max) * 100}%` }} />
              </td>
              <td className="num">{fmtNum(it.days)}</td>
              {showCategory && <td className="small">{it.top_category_label || it.top_category || '–'}</td>}
              <td className="small muted" style={{ whiteSpace: 'nowrap' }}>
                {fmtDateTime(it.last_seen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
