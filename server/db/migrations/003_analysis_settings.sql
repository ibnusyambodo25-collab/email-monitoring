-- Tahap 3: ambang analisis yang bisa diatur dari halaman Pengaturan.

-- Lonjakan: jumlah per jam/hari >= spike_ratio × rata-rata 7 hari sebelumnya
-- (jam yang sama untuk analisis per jam) DAN >= spike_min_count.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS spike_ratio numeric(6, 2) NOT NULL DEFAULT 2
  CHECK (spike_ratio >= 1);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS spike_min_count integer NOT NULL DEFAULT 5
  CHECK (spike_min_count >= 1);
-- "Berulang": muncul di sedikitnya N hari berbeda.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS recurring_min_days integer NOT NULL DEFAULT 3
  CHECK (recurring_min_days >= 2);

-- Agregasi per jam/hari dihitung dalam zona Asia/Jakarta.
CREATE INDEX IF NOT EXISTS rejections_final_recipient_idx ON rejections (final_recipient, waktu)
  WHERE final_recipient IS NOT NULL;
CREATE INDEX IF NOT EXISTS rejections_recipient_domain_idx ON rejections (recipient_domain, waktu);
