-- Tahap 1: pengaturan, pelacakan email di mailbox (UIDL), riwayat sinkronisasi, log.

CREATE TABLE IF NOT EXISTS settings (
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pop3_host               text    NOT NULL DEFAULT '',
  pop3_port               integer NOT NULL DEFAULT 995 CHECK (pop3_port BETWEEN 1 AND 65535),
  pop3_tls                boolean NOT NULL DEFAULT true,
  pop3_allow_invalid_cert boolean NOT NULL DEFAULT false,
  pop3_username           text    NOT NULL DEFAULT '',
  -- Password terenkripsi AES-256-GCM; kunci ada di .env (APP_ENCRYPTION_KEY).
  pop3_password_iv        bytea,
  pop3_password_tag       bytea,
  pop3_password_ct        bytea,
  watch_sender            text    NOT NULL DEFAULT 'root@srv.gracia.co.id',
  watch_subject           text    NOT NULL DEFAULT '[ALERT HOURLY] Ada Email Rejected/Gagal ke @gracia.co.id',
  fetch_interval_minutes  integer NOT NULL DEFAULT 60 CHECK (fetch_interval_minutes BETWEEN 1 AND 1440),
  auto_fetch_enabled      boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Setiap email di mailbox yang sudah diperiksa, dikunci dengan UIDL supaya tidak
-- diunduh/dihitung dua kali. Email yang tidak cocok filter juga dicatat (status
-- 'ignored') supaya tidak perlu di-TOP ulang tiap sinkronisasi.
CREATE TABLE IF NOT EXISTS mailbox_messages (
  uidl             text PRIMARY KEY,
  status           text NOT NULL CHECK (status IN ('ignored', 'imported', 'no_csv', 'error')),
  from_address     text,
  subject          text,
  email_date       timestamptz,
  message_id       text,
  attachment_count integer NOT NULL DEFAULT 0,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailbox_messages_status_idx ON mailbox_messages (status);
CREATE INDEX IF NOT EXISTS mailbox_messages_email_date_idx ON mailbox_messages (email_date);

CREATE TABLE IF NOT EXISTS sync_runs (
  id               bigserial PRIMARY KEY,
  trigger          text NOT NULL CHECK (trigger IN ('manual', 'auto')),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  messages_total   integer NOT NULL DEFAULT 0,
  messages_new     integer NOT NULL DEFAULT 0,
  messages_matched integer NOT NULL DEFAULT 0,
  reports_imported integer NOT NULL DEFAULT 0,
  rows_imported    integer NOT NULL DEFAULT 0,
  rows_failed      integer NOT NULL DEFAULT 0,
  error_message    text
);
CREATE INDEX IF NOT EXISTS sync_runs_started_at_idx ON sync_runs (started_at DESC);

-- Log yang ditampilkan di halaman Status. "message" ditulis untuk orang non-teknis;
-- "detail" berisi info teknis (tanpa password).
CREATE TABLE IF NOT EXISTS app_events (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  level       text NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message     text NOT NULL,
  detail      text,
  sync_run_id bigint REFERENCES sync_runs (id) ON DELETE SET NULL,
  uidl        text
);
CREATE INDEX IF NOT EXISTS app_events_created_at_idx ON app_events (created_at DESC);
CREATE INDEX IF NOT EXISTS app_events_level_idx ON app_events (level, created_at DESC);
