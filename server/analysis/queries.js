import { query } from '../db/pool.js';
import { ValidationError } from '../settings.js';
import { Sql, TZ, filterConditions, parseRange, where } from './filters.js';

// Semua agregasi dikerjakan PostgreSQL; Node hanya merangkai query dan meneruskan hasil.

const BUCKETS = { hour: { unit: 'hour', step: '1 hour', maxPoints: 24 * 62, ma: 24 }, day: { unit: 'day', step: '1 day', maxPoints: 800, ma: 7 } };

function bucketOf(q) {
  const b = BUCKETS[q.bucket || 'hour'];
  if (!b) throw new ValidationError('bucket harus "hour" atau "day".');
  return b;
}

// Kolom yang boleh dipakai untuk top-N / baru-vs-berulang (whitelist, bukan input bebas).
export const DIMENSIONS = {
  sender: { expr: 'r.sender', label: 'Pengirim' },
  sender_domain: { expr: 'r.sender_base_domain', label: 'Domain pengirim' },
  recipient: { expr: 'r.recipient', label: 'Penerima' },
  recipient_domain: { expr: 'r.recipient_domain', label: 'Domain penerima' },
  final_recipient: { expr: 'r.final_recipient', label: 'Tujuan forward/alias' },
  category: { expr: 'r.reason_category', label: 'Kategori alasan' },
  code: { expr: 'coalesce(r.enhanced_code, r.smtp_code)', label: 'Kode error' },
  // Teks alasan dengan alamat email & IP disamarkan supaya alasan yang sama terkelompok.
  reason_text: {
    expr: `regexp_replace(regexp_replace(left(r.penyebab_bersih, 400), '<?[^[:space:]<>()]+@[^[:space:]<>()]*[[:alnum:]]>?', '<alamat>', 'g'), '\\[[0-9a-fA-F.:]+\\]', '[ip]', 'g')`,
    label: 'Alasan (teks)',
  },
};

function dimensionOf(name) {
  const d = DIMENSIONS[name];
  if (!d) throw new ValidationError(`dimension tidak dikenal. Pilihan: ${Object.keys(DIMENSIONS).join(', ')}`);
  return d;
}

async function analysisSettings() {
  const { rows } = await query('SELECT spike_ratio::float AS ratio, spike_min_count AS min, recurring_min_days AS days FROM settings WHERE id = 1');
  return rows[0];
}

// ---------- Ringkasan ----------

async function summaryFor(q, range) {
  const sql = new Sql();
  const w = where(filterConditions(sql, q, { range }));
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE r.direction = 'inbound')::int  AS inbound,
            count(*) FILTER (WHERE r.direction = 'outbound')::int AS outbound,
            count(*) FILTER (WHERE r.direction = 'internal')::int AS internal,
            count(*) FILTER (WHERE r.direction = 'forward')::int  AS forward,
            count(*) FILTER (WHERE r.direction = 'unknown')::int  AS unknown,
            count(*) FILTER (WHERE r.is_probe)::int AS probe,
            count(DISTINCT r.recipient)::int AS unique_recipients,
            count(DISTINCT r.sender)::int AS unique_senders,
            count(DISTINCT r.sender_base_domain)::int AS unique_sender_domains,
            count(DISTINCT r.report_id)::int AS reports
       FROM rejections r ${w}`,
    sql.params,
  );
  return rows[0];
}

export async function summary(q) {
  const range = parseRange(q);
  const len = range.to - range.from;
  const prevRange = { from: new Date(range.from - len), to: range.from };

  const sql = new Sql();
  const w = where(filterConditions(sql, q, { range }));
  const [current, previous, categories] = await Promise.all([
    summaryFor(q, range),
    summaryFor(q, prevRange),
    query(
      `SELECT r.reason_category AS code, coalesce(c.label, r.reason_category) AS label, count(*)::int AS n
         FROM rejections r LEFT JOIN reason_categories c ON c.code = r.reason_category
         ${w}
        GROUP BY 1, 2 ORDER BY n DESC`,
      sql.params,
    ),
  ]);
  return { range, previousRange: prevRange, current, previous, categories: categories.rows };
}

// ---------- Tren per jam / per hari ----------

export async function trend(q) {
  const range = parseRange(q);
  const b = bucketOf(q);
  const points = Math.ceil((range.to - range.from) / (b.unit === 'hour' ? 3600_000 : 86400_000));
  if (points > b.maxPoints) {
    throw new ValidationError(`Rentang terlalu panjang untuk tampilan per ${b.unit === 'hour' ? 'jam' : 'hari'}. Pilih per hari atau persempit rentang.`);
  }
  const sql = new Sql();
  const w = where(filterConditions(sql, q, { range }));
  const pFrom = sql.p(range.from);
  const pTo = sql.p(range.to);
  const { rows } = await query(
    `WITH series AS (
       SELECT generate_series(date_trunc('${b.unit}', ${pFrom}::timestamptz AT TIME ZONE ${TZ}),
                              (${pTo}::timestamptz AT TIME ZONE ${TZ}) - interval '1 microsecond',
                              interval '${b.step}') AS b
     ), data AS (
       SELECT date_trunc('${b.unit}', r.waktu AT TIME ZONE ${TZ}) AS b, r.reason_category AS cat, count(*)::int AS n
         FROM rejections r ${w}
        GROUP BY 1, 2
     ), merged AS (
       SELECT s.b,
              coalesce(sum(d.n), 0)::int AS total,
              coalesce(jsonb_object_agg(d.cat, d.n) FILTER (WHERE d.cat IS NOT NULL), '{}'::jsonb) AS by_category
         FROM series s LEFT JOIN data d ON d.b = s.b
        GROUP BY s.b
     )
     SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
            (b AT TIME ZONE ${TZ}) AS bucket_start,
            total,
            round(avg(total) OVER (ORDER BY b ROWS BETWEEN ${b.ma - 1} PRECEDING AND CURRENT ROW), 2)::float AS moving_avg,
            by_category
       FROM merged ORDER BY b`,
    sql.params,
  );
  return { bucket: b.unit, movingAvgWindow: b.ma, points: rows };
}

// ---------- Top-N ----------

export async function top(q) {
  const range = parseRange(q);
  const dim = dimensionOf(q.dimension || 'recipient');
  const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 100);
  const sql = new Sql();
  const conds = filterConditions(sql, q, { range });
  const { rows } = await query(
    `WITH x AS (
       SELECT ${dim.expr} AS key, r.waktu, r.reason_category FROM rejections r ${where(conds)}
     ), g AS (
       SELECT key, count(*)::int AS n, min(waktu) AS first_seen, max(waktu) AS last_seen,
              count(DISTINCT (waktu AT TIME ZONE ${TZ})::date)::int AS days,
              mode() WITHIN GROUP (ORDER BY reason_category) AS top_category,
              round(100.0 * count(*) / sum(count(*)) OVER (), 1)::float AS share
         FROM x WHERE key IS NOT NULL AND key <> ''
        GROUP BY key
     )
     SELECT g.*, c.label AS category_label, tc.label AS top_category_label
       FROM g
       LEFT JOIN reason_categories c ON ${q.dimension === 'category' ? 'c.code = g.key' : 'false'}
       LEFT JOIN reason_categories tc ON tc.code = g.top_category
      ORDER BY g.n DESC, g.key
      LIMIT ${sql.p(limit)}`,
    sql.params,
  );
  return { dimension: q.dimension || 'recipient', label: dim.label, items: rows };
}

// ---------- Lonjakan ----------
// Per jam: dibandingkan rata-rata jam yang SAMA selama 7 hari sebelumnya.
// Per hari: dibandingkan rata-rata 7 hari sebelumnya. Ditandai lonjakan bila
// jumlah >= rasio × rata-rata DAN >= jumlah minimum (dari Pengaturan).
// Hanya dinilai bila sudah ada riwayat data 7 hari sebelum jam/hari tersebut, supaya
// hari-hari pertama pemakaian (rata-rata masih 0) tidak dianggap lonjakan.

export async function spikes(q) {
  const range = parseRange(q);
  const b = bucketOf(q);
  const s = await analysisSettings();
  const sql = new Sql();
  const conds = filterConditions(sql, q);
  const pFrom = sql.p(range.from);
  const pTo = sql.p(range.to);
  conds.push(`r.waktu >= ${pFrom}::timestamptz - interval '7 days' AND r.waktu < ${pTo}`);
  const sameHour = b.unit === 'hour' ? `AND p.b::time = c.b::time` : '';
  const { rows } = await query(
    `WITH counts AS (
       SELECT date_trunc('${b.unit}', r.waktu AT TIME ZONE ${TZ}) AS b, count(*)::int AS n
         FROM rejections r ${where(conds)} GROUP BY 1
     ), scored AS (
       SELECT c.b, c.n,
              coalesce((SELECT p.n FROM counts p WHERE p.b = c.b - interval '${b.step}'), 0) AS prev_n,
              round(coalesce((SELECT sum(p.n) FROM counts p
                               WHERE p.b >= c.b - interval '7 days' AND p.b < c.b ${sameHour}), 0) / 7.0, 2)::float AS baseline
         FROM counts c
        WHERE c.b >= date_trunc('${b.unit}', ${pFrom}::timestamptz AT TIME ZONE ${TZ})
          AND c.b - interval '7 days' >= (SELECT date_trunc('${b.unit}', min(waktu) AT TIME ZONE ${TZ}) FROM rejections)
     )
     SELECT to_char(b, 'YYYY-MM-DD"T"HH24:MI') AS bucket, (b AT TIME ZONE ${TZ}) AS bucket_start,
            n, prev_n, baseline,
            CASE WHEN baseline > 0 THEN round((n / baseline)::numeric, 1)::float END AS ratio
       FROM scored
      WHERE n >= ${sql.p(s.min)} AND n >= ${sql.p(s.ratio)} * baseline
      ORDER BY b DESC`,
    sql.params,
  );
  const first = await query(`SELECT min(waktu) AS first FROM rejections`);
  const dataSince = first.rows[0].first;
  const evaluableFrom = dataSince ? new Date(new Date(dataSince).getTime() + 7 * 86400_000) : null;
  return { bucket: b.unit, thresholds: { ratio: s.ratio, minCount: s.min }, dataSince, evaluableFrom, items: rows };
}

// ---------- Baru vs berulang ----------
// baru     = pertama kali muncul (sepanjang riwayat) di dalam rentang yang dipilih
// berulang = sudah muncul di >= N hari berbeda (N dari Pengaturan)
// sesekali = selain itu

export async function newVsRecurring(q) {
  const range = parseRange(q);
  const dim = dimensionOf(q.dimension || 'recipient');
  const s = await analysisSettings();
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const status = ['baru', 'berulang', 'sesekali'].includes(q.status) ? q.status : null;

  const sql = new Sql();
  const inRangeConds = filterConditions(sql, q, { range });
  const histConds = filterConditions(sql, q);
  const pFrom = sql.p(range.from);
  const pTo = sql.p(range.to);
  const pDays = sql.p(s.days);
  const pStatus = sql.p(status);
  const { rows } = await query(
    `WITH in_range AS (
       SELECT ${dim.expr} AS key, count(*)::int AS n
         FROM rejections r ${where(inRangeConds)}
        GROUP BY 1
       HAVING ${dim.expr} IS NOT NULL AND ${dim.expr} <> ''
     ), hist AS (
       SELECT ${dim.expr} AS key, min(r.waktu) AS first_seen, max(r.waktu) AS last_seen,
              count(DISTINCT (r.waktu AT TIME ZONE ${TZ})::date)::int AS days_seen,
              count(*)::int AS total_all
         FROM rejections r
        ${where([...histConds, `r.waktu < ${pTo}`, `${dim.expr} IN (SELECT key FROM in_range)`])}
        GROUP BY 1
     ), classified AS (
       SELECT i.key, i.n, h.first_seen, h.last_seen, h.days_seen, h.total_all,
              CASE WHEN h.first_seen >= ${pFrom} THEN 'baru'
                   WHEN h.days_seen >= ${pDays} THEN 'berulang'
                   ELSE 'sesekali' END AS status
         FROM in_range i JOIN hist h USING (key)
     ), page AS (
       SELECT * FROM classified
        WHERE ${pStatus}::text IS NULL OR status = ${pStatus}
        ORDER BY n DESC, key
        LIMIT ${sql.p(limit)} OFFSET ${sql.p(offset)}
     )
     SELECT (SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
               FROM (SELECT status, count(*)::int AS c FROM classified GROUP BY status) t) AS counts,
            (SELECT coalesce(jsonb_agg(page ORDER BY n DESC, key), '[]'::jsonb) FROM page) AS items`,
    sql.params,
  );
  const counts = { baru: 0, berulang: 0, sesekali: 0, ...rows[0].counts };
  return {
    dimension: q.dimension || 'recipient',
    label: dim.label,
    recurringMinDays: s.days,
    counts,
    total: status ? counts[status] : counts.baru + counts.berulang + counts.sesekali,
    items: rows[0].items,
  };
}

// ---------- Temuan yang bisa ditindaklanjuti ----------

export async function insights(q) {
  const base = { ...q, limit: q.limit || 10 };
  const [forwardFailures, missingMailboxes, outboundFailures, probedRecipients] = await Promise.all([
    // Mailbox @gracia yang forward-nya ditolak (mis. SPF di Gmail) → perbaiki forwarding.
    top({ ...base, dimension: 'recipient', direction: 'forward' }),
    // Alamat @gracia yang tidak ada tetapi terus dikirimi (bukan probe).
    top({ ...base, dimension: 'recipient', category: 'no_such_user', direction: 'inbound,internal', probe: 'exclude' }),
    // Staf yang mengirim keluar ke alamat/domain yang gagal.
    top({ ...base, dimension: 'sender', direction: 'outbound' }),
    // Alamat yang dicoba-coba oleh layanan pengecek email.
    top({ ...base, dimension: 'recipient', probe: 'only' }),
  ]);
  return {
    forwardFailures: forwardFailures.items,
    missingMailboxes: missingMailboxes.items,
    outboundFailures: outboundFailures.items,
    probedRecipients: probedRecipients.items,
  };
}
