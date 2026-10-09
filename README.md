# Monitor Email Rejected

Aplikasi lokal yang mengambil email alert **"[ALERT HOURLY] Ada Email Rejected/Gagal ke @gracia.co.id"**
(dari `root@srv.gracia.co.id`) lewat POP3, menyimpan lampiran CSV-nya, memasukkan isinya ke PostgreSQL,
lalu menampilkan analisisnya di browser.

- **Mailbox hanya dibaca.** Aplikasi tidak pernah mengirim perintah `DELE`, jadi email tetap ada di server.
- Hanya header yang dibaca untuk setiap email (`TOP`). Email baru diunduh lengkap (`RETR`) jika pengirim dan subjeknya cocok.
- Setiap email dicatat berdasarkan `UIDL`, sehingga tidak ada yang diunduh atau dihitung dua kali.
- Server hanya bisa diakses dari komputer ini (`127.0.0.1`).

---

## 1. Kebutuhan

| Perangkat | Versi |
|---|---|
| Node.js | 22 LTS atau lebih baru (diuji dengan 24) |
| PostgreSQL | 13 atau lebih baru (diuji dengan 18) |

## 2. Instalasi

```bash
cd rejected-mail-monitor
npm install
```

## 3. Menyiapkan database dan file `.env`

1. Salin `.env.example` menjadi `.env` (lewati jika `.env` sudah ada).
2. Isi `DATABASE_URL` dengan user dan password PostgreSQL Anda:
   ```
   DATABASE_URL=postgres://postgres:PASSWORD_ANDA@localhost:5432/rejected_mail
   ```
   Database `rejected_mail` **dibuat otomatis** saat migrasi, asalkan user tersebut boleh membuat database.
   Jika tidak boleh, buat dulu databasenya secara manual, misalnya lewat pgAdmin.
3. Isi `APP_ENCRYPTION_KEY`, yaitu kunci untuk mengenkripsi password POP3. Buat dengan:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   > Jangan ganti kunci ini setelah password POP3 tersimpan. Kalau terganti, password lama tidak bisa
   > dibuka dan harus diisi ulang di halaman Pengaturan.
4. `APP_PORT` (opsional, default `3000`) adalah port server aplikasi.

File `.env` sudah masuk `.gitignore`, jadi jangan dibagikan.

## 4. Menjalankan migrasi

```bash
npm run migrate
```

Perintah ini aman dijalankan berulang kali: migrasi yang sudah diterapkan otomatis dilewati.
Jalankan lagi setiap kali ada file baru di `server/db/migrations/`.

## 5. Menjalankan aplikasi

**Pemakaian sehari-hari:**

```bash
npm start
```

Perintah ini mem-build tampilan lalu menjalankan server. Buka **http://localhost:3000**.

**Saat mengubah kode** (tampilan dan server otomatis dimuat ulang):

```bash
npm run dev
```

Buka **http://localhost:5173**.

Selama server berjalan, email diambil otomatis setiap N menit (default 60).

## 6. Mengisi konfigurasi

Buka halaman **Pengaturan**:

1. **Koneksi POP3**:
   - Server: `mail.gracia.co.id`
   - Port: `995`, centang **SSL/TLS**
   - Username: alamat email mailbox
   - Password
2. Klik **Tes koneksi**. Jika berhasil, akan muncul jumlah email di mailbox.
3. **Email yang diawasi** sudah terisi default (`root@srv.gracia.co.id` dan subjek alert). Ubah hanya jika perlu.
4. Klik **Simpan pengaturan**, lalu tekan **Ambil email sekarang** di kanan atas.

> **Catatan POP3:** satu mailbox hanya bisa dibuka satu sesi POP3 pada satu waktu. Jika Outlook sedang
> mengambil email, aplikasi akan melaporkan "Mailbox sedang dipakai sesi lain" dan mencoba lagi pada jadwal berikutnya.
>
> Pada pengambilan pertama, aplikasi memeriksa header semua email yang ada di mailbox. Proses ini bisa memakan waktu.
> Pengambilan berikutnya hanya memeriksa email baru.

## 7. Halaman

| Halaman | Isi |
|---|---|
| **Dashboard** | Angka ringkasan dibanding periode sebelumnya, tren per jam/hari per kategori alasan, top-N (penerima, pengirim, domain, kode error, teks alasan), lonjakan, temuan yang perlu ditindaklanjuti, serta perbandingan baru vs berulang. Klik baris mana pun untuk membuka detailnya. |
| **Detail** | Semua baris data dengan pencarian, filter, urutan, dan halaman (diproses di server). Bisa diekspor ke **CSV** atau **Excel**. Klik baris untuk melihat alasan lengkap dan mengunduh file CSV aslinya. |
| **Pengaturan** | Koneksi POP3, filter pengirim/subjek, jadwal, ambang analisis, dan aturan kategori alasan. |
| **Status** | Waktu sinkronisasi terakhir, jumlah email yang diproses, email report yang bermasalah (misalnya tidak ada lampiran CSV), catatan kejadian, dan file report asli. |

## 8. Cara data diolah

- File CSV asli disimpan di `data/raw/TAHUN/BULAN/` dengan nama yang memuat tanggal dan jam email (WIB),
  misalnya `2026-10-08_12-05-03_rejected_email_hourly_ab12cd34.csv`.
- Kolom `Waktu` di CSV dianggap WIB, lalu disimpan sebagai `timestamptz`.
- Setiap baris disimpan **apa adanya**. Jika baris yang sama muncul di dua report, keduanya tetap dihitung.
- Kolom tambahan dihitung otomatis:
  - **Penerima** diambil dari kolom Penerima. Jika kosong, dibaca dari log server email di kolom Penyebab.
  - **Tujuan forward/alias**, misalnya mailbox yang diteruskan ke Gmail.
  - **Arah**: Masuk, Keluar, Internal, atau Forward.
  - **Kode SMTP** (`550`) dan kode status (`5.7.27`).
  - **Kategori alasan**, berdasarkan aturan regex yang bisa diubah di Pengaturan. Setiap perubahan aturan
    langsung mengklasifikasi ulang semua data.
  - **Pengecek email**: pengirim dari domain layanan verifikasi alamat (misalnya `fastemailclean.com`).
- CSV dengan delimiter koma atau titik koma, encoding UTF-8 atau Latin-1, dan baris kosong ditangani otomatis.
  Baris yang rusak dicatat (lihat Status) tanpa menghentikan proses.

**Definisi analisis:**

- **Lonjakan**: jumlah dalam satu jam/hari ≥ *rasio* × rata-rata 7 hari sebelumnya (untuk per jam: pada jam
  yang sama) **dan** ≥ *jumlah minimum*. Default rasio 2× dan minimum 5. Lonjakan baru dinilai setelah ada riwayat data 7 hari.
- **Baru**: pertama kali muncul di rentang yang dipilih.
- **Berulang**: sudah muncul di ≥ N hari berbeda (default 3).
- **Sesekali**: sisanya.

## 9. Perintah lain

```bash
npm test                                # semua test
npm run fetch                           # ambil email sekali dari terminal
npm run import-csv -- samples           # impor manual file/folder CSV (file yang sama tidak diimpor dua kali)
npm run build                           # build tampilan ke web/dist
```

**Tentang test:**

- Test email dan CSV memakai contoh email buatan (`test/fixtures/`) dan server POP3 palsu, jadi tidak perlu koneksi ke server email.
- Test database memakai database terpisah bernama `<nama_db>_test` (dibuat otomatis) dan folder sementara,
  sehingga data Anda tidak tersentuh. Test ini dilewati bila `DATABASE_URL` belum diisi.

## 10. Struktur proyek

```
server/
  index.js            titik masuk server (Express, hanya 127.0.0.1)
  config.js, crypto.js
  db/                 koneksi, migrate.js, migrations/*.sql
  pop3/               klien POP3 read-only, pencocokan email, pesan error
  ingest/             parsing CSV, kolom turunan, penyimpanan
  analysis/           query agregasi SQL
  routes/             endpoint API
  sync.js, scheduler.js
  cli/                npm run fetch / import-csv
web/                  tampilan React (Vite + Recharts)
samples/              contoh CSV
data/raw/             file CSV asli hasil unduhan (tidak masuk git)
test/                 test + fixture
```

## 11. Jika ada masalah

| Pesan | Yang perlu dicek |
|---|---|
| *Login ditolak server: username atau password POP3 salah* | Username/password di Pengaturan |
| *Server "…" tidak ditemukan* | Penulisan nama server, koneksi jaringan/DNS |
| *Server … tidak merespons (timeout)* | Jaringan/firewall; pastikan port 995 dipakai dengan SSL/TLS aktif |
| *Gagal membuat koneksi SSL/TLS* | Kecocokan port dan SSL (995 + SSL, atau 110 tanpa SSL) |
| *Sertifikat SSL server … tidak dipercaya* | Nama server harus sama dengan nama di sertifikat |
| *Mailbox sedang dipakai sesi lain* | Tunggu Outlook selesai mengambil email |
| *Tidak bisa terhubung ke PostgreSQL* | Layanan PostgreSQL berjalan, `DATABASE_URL` benar |
| *Tabel database belum ada* | Jalankan `npm run migrate` |
"# email-monitoring" 
