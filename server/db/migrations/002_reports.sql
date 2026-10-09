-- Tahap 2: file report, baris CSV, baris yang gagal diparse, aturan kategori alasan.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS internal_domain text NOT NULL DEFAULT 'gracia.co.id';
-- Domain layanan "pengecek alamat email" (bukan email sungguhan). Subdomain ikut cocok.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS probe_domains text[] NOT NULL
  DEFAULT ARRAY['fastemailclean.com', 'bounceprevention.com'];

CREATE TABLE IF NOT EXISTS reports (
  id                bigserial PRIMARY KEY,
  source            text NOT NULL CHECK (source IN ('pop3', 'manual')),
  uidl              text REFERENCES mailbox_messages (uidl) ON DELETE CASCADE,
  attachment_index  integer NOT NULL DEFAULT 0,
  email_date        timestamptz,
  original_filename text NOT NULL,
  stored_path       text NOT NULL,
  sha256            text NOT NULL,
  encoding          text,
  delimiter         text,
  row_count         integer NOT NULL DEFAULT 0,
  error_count       integer NOT NULL DEFAULT 0,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'manual' OR uidl IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_uidl_attachment_uq ON reports (uidl, attachment_index) WHERE uidl IS NOT NULL;
-- File yang sama tidak diimpor manual dua kali.
CREATE UNIQUE INDEX IF NOT EXISTS reports_manual_sha256_uq ON reports (sha256) WHERE source = 'manual';
CREATE INDEX IF NOT EXISTS reports_email_date_idx ON reports (email_date DESC);

CREATE TABLE IF NOT EXISTS reason_categories (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100
);

-- Aturan pengelompokan kolom Penyebab. pattern = regex PostgreSQL (tidak peka huruf
-- besar/kecil). Aturan dengan priority terkecil yang cocok lebih dulu dipakai.
CREATE TABLE IF NOT EXISTS reason_rules (
  id         serial PRIMARY KEY,
  category   text NOT NULL REFERENCES reason_categories (code) ON UPDATE CASCADE,
  pattern    text NOT NULL,
  priority   integer NOT NULL DEFAULT 100,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, pattern)
);

INSERT INTO reason_categories (code, label, sort_order) VALUES
  ('spf_dmarc_fail',   'Ditolak: SPF/DMARC tidak lolos (sering pada forward ke Gmail)', 10),
  ('no_such_user',     'Alamat penerima tidak ada', 20),
  ('remote_not_exist', 'Domain/akun tujuan tidak ada atau DNS bermasalah', 30),
  ('mailbox_full',     'Kotak surat penerima penuh', 40),
  ('too_large',        'Ukuran email terlalu besar', 45),
  ('blocked_spam',     'Diblokir: spam/reputasi/daftar hitam', 50),
  ('connection',       'Gagal koneksi/timeout ke server tujuan', 60),
  ('other',            'Lainnya', 999)
ON CONFLICT (code) DO NOTHING;

INSERT INTO reason_rules (category, pattern, priority) VALUES
  ('spf_dmarc_fail',   '\mSPF\M|DMARC|5\.7\.2[3-9]|authentication (didn.t|did not) pass|not authenticated', 10),
  ('no_such_user',     'no such (person|user)|user unknown|unknown (user|recipient)|recipient address rejected|mailbox (unavailable|not found)|address (does not|doesn.t) exist|5\.1\.1', 20),
  ('remote_not_exist', 'account or domain may not exist|domain (not found|does not exist)|host or domain name not found|no mx|unrouteable|nxdomain|non-existent host', 30),
  ('mailbox_full',     'mailbox (is )?full|over ?quota|quota exceeded|insufficient (system )?storage|5\.2\.2', 40),
  ('too_large',        'message (size|too large)|exceeds .*size|too big|5\.3\.4', 45),
  ('blocked_spam',     'spam|blocked|black ?list|block ?list|listed (at|on|in)|\mrbl\M|reputation|5\.7\.1\M', 50),
  ('connection',       'timed? ?out|connection refused|retry time not reached|could not connect|network is unreachable', 60)
ON CONFLICT (category, pattern) DO NOTHING;

CREATE TABLE IF NOT EXISTS rejections (
  id                 bigserial PRIMARY KEY,
  report_id          bigint  NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  -- Kolom asli CSV (apa adanya)
  waktu              timestamptz NOT NULL,
  pengirim           text NOT NULL DEFAULT '',
  penerima           text NOT NULL DEFAULT '',
  penyebab           text NOT NULL DEFAULT '',
  -- Kolom turunan
  penyebab_bersih    text NOT NULL DEFAULT '',
  sender             text,
  sender_domain      text,
  sender_base_domain text,
  recipient          text,
  recipient_domain   text,
  final_recipient    text,
  direction          text NOT NULL DEFAULT 'unknown'
                     CHECK (direction IN ('inbound', 'outbound', 'internal', 'forward', 'unknown')),
  smtp_code          text,
  enhanced_code      text,
  router             text,
  remote_host        text,
  reason_category    text NOT NULL DEFAULT 'other',
  is_probe           boolean NOT NULL DEFAULT false,
  search_text        text GENERATED ALWAYS AS (lower(pengirim || ' ' || penerima || ' ' || penyebab)) STORED,
  UNIQUE (report_id, line_no)
);
CREATE INDEX IF NOT EXISTS rejections_waktu_idx ON rejections (waktu);
CREATE INDEX IF NOT EXISTS rejections_recipient_idx ON rejections (recipient, waktu);
CREATE INDEX IF NOT EXISTS rejections_sender_idx ON rejections (sender, waktu);
CREATE INDEX IF NOT EXISTS rejections_sender_base_domain_idx ON rejections (sender_base_domain, waktu);
CREATE INDEX IF NOT EXISTS rejections_category_idx ON rejections (reason_category, waktu);
CREATE INDEX IF NOT EXISTS rejections_direction_idx ON rejections (direction, waktu);
CREATE INDEX IF NOT EXISTS rejections_search_trgm_idx ON rejections USING gin (search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS parse_errors (
  id         bigserial PRIMARY KEY,
  report_id  bigint NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  line_no    integer,
  raw_line   text,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parse_errors_report_idx ON parse_errors (report_id);

-- Mengisi ulang reason_category dan is_probe berdasarkan aturan dan pengaturan saat ini.
-- p_report_id NULL = semua baris (dipakai setelah aturan/daftar domain diubah).
CREATE OR REPLACE FUNCTION classify_rejections(p_report_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  UPDATE rejections r
     SET reason_category = c.category,
         is_probe        = c.probe
    FROM (
      SELECT x.id,
             COALESCE((SELECT rr.category
                         FROM reason_rules rr
                        WHERE rr.enabled AND x.penyebab_bersih ~* rr.pattern
                        ORDER BY rr.priority, rr.id
                        LIMIT 1), 'other') AS category,
             COALESCE(x.sender_domain IS NOT NULL AND EXISTS (
               SELECT 1 FROM settings s, unnest(s.probe_domains) d
                WHERE x.sender_domain = lower(d) OR x.sender_domain LIKE '%.' || lower(d)
             ), false) AS probe
        FROM rejections x
       WHERE p_report_id IS NULL OR x.report_id = p_report_id
    ) c
   WHERE r.id = c.id
     AND (r.reason_category IS DISTINCT FROM c.category OR r.is_probe IS DISTINCT FROM c.probe);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
