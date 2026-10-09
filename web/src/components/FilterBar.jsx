import { PRESETS, DIRECTION_LABELS, jakartaYmd, useApi } from '../lib.js';

// Satu baris filter di atas semua grafik/tabel; semuanya ikut filter ini.
export default function FilterBar({ filters, setFilters, children }) {
  const cats = useApi('/categories');
  const today = jakartaYmd();
  return (
    <div className="filterbar" role="group" aria-label="Filter">
      <div className="seg" role="radiogroup" aria-label="Rentang tanggal">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            role="radio"
            aria-checked={filters.preset === p.key}
            className={filters.preset === p.key ? 'on' : ''}
            onClick={() =>
              setFilters(
                p.key === 'custom' && !filters.fromDate ? { preset: 'custom', fromDate: today, toDate: today } : { preset: p.key },
              )
            }
          >
            {p.label}
          </button>
        ))}
      </div>
      {filters.preset === 'custom' && (
        <>
          <label>
            Dari
            <input type="date" value={filters.fromDate} max={today} onChange={(e) => setFilters({ fromDate: e.target.value })} />
          </label>
          <label>
            s.d.
            <input type="date" value={filters.toDate} max={today} onChange={(e) => setFilters({ toDate: e.target.value })} />
          </label>
        </>
      )}
      <label>
        Arah
        <select value={filters.direction} onChange={(e) => setFilters({ direction: e.target.value })}>
          <option value="">Semua</option>
          {Object.entries(DIRECTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kategori
        <select value={filters.category} onChange={(e) => setFilters({ category: e.target.value })} style={{ maxWidth: 260 }}>
          <option value="">Semua</option>
          {(cats.data || []).map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label title="Layanan pengecek alamat email (mis. fastemailclean.com) yang mencoba-coba alamat">
        Pengecek email
        <select value={filters.probe} onChange={(e) => setFilters({ probe: e.target.value })}>
          <option value="all">Tampilkan</option>
          <option value="exclude">Sembunyikan</option>
          <option value="only">Hanya pengecek</option>
        </select>
      </label>
      {children}
    </div>
  );
}

export function filterParams(filters, range) {
  return {
    from: range.from,
    to: range.to,
    direction: filters.direction,
    category: filters.category,
    probe: filters.probe === 'all' ? '' : filters.probe,
  };
}
