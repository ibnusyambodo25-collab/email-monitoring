import { useEffect, useState } from 'react';
import { api, useApi } from '../lib.js';

function Message({ msg }) {
  if (!msg) return null;
  return (
    <div className={`alert ${msg.kind}`} role="status">
      <span className="icon">{msg.kind === 'ok' ? '✓' : msg.kind === 'warning' ? '!' : '✕'}</span>
      <div style={{ whiteSpace: 'pre-line' }}>{msg.text}</div>
    </div>
  );
}

export default function Settings({ onSaved }) {
  const settings = useApi('/settings');
  const client = useApi('/client');
  const readOnly = client.data ? !client.data.canEdit : false;
  const [form, setForm] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    if (settings.data) setForm({ ...settings.data, probe_domains: settings.data.probe_domains.join('\n') });
  }, [settings.data]);

  if (settings.error) return <Message msg={{ kind: 'error', text: settings.error }} />;
  if (!form) return <div className="empty">Memuat…</div>;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const pop3Fields = () => ({
    pop3_host: form.pop3_host,
    pop3_port: Number(form.pop3_port),
    pop3_tls: form.pop3_tls,
    pop3_allow_invalid_cert: form.pop3_allow_invalid_cert,
    pop3_username: form.pop3_username,
  });

  const save = async (e) => {
    e.preventDefault();
    setBusy('save');
    setMsg(null);
    try {
      const body = {
        ...pop3Fields(),
        watch_sender: form.watch_sender,
        watch_subject: form.watch_subject,
        fetch_interval_minutes: Number(form.fetch_interval_minutes),
        auto_fetch_enabled: form.auto_fetch_enabled,
        internal_domain: form.internal_domain,
        probe_domains: form.probe_domains,
        spike_ratio: Number(form.spike_ratio),
        spike_min_count: Number(form.spike_min_count),
        recurring_min_days: Number(form.recurring_min_days),
      };
      if (password) body.password = password;
      const res = await api('/settings', { method: 'PUT', body });
      setPassword('');
      setForm({ ...res.settings, probe_domains: res.settings.probe_domains.join('\n') });
      setMsg({ kind: 'ok', text: ['Pengaturan disimpan.', ...res.notes].join('\n') });
      onSaved?.();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setTestMsg(null);
    try {
      const res = await api('/settings/test-connection', { method: 'POST', body: { ...pop3Fields(), password: password || undefined } });
      setTestMsg({ kind: res.ok ? 'ok' : 'error', text: res.message });
    } catch (err) {
      setTestMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(null);
    }
  };

  const clearPassword = async () => {
    if (!window.confirm('Hapus password POP3 yang tersimpan? Pengambilan email otomatis akan berhenti sampai password diisi lagi.')) return;
    try {
      const res = await api('/settings', { method: 'PUT', body: { clear_password: true } });
      setForm((f) => ({ ...f, has_password: res.settings.has_password }));
      setMsg({ kind: 'ok', text: 'Password dihapus.' });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    }
  };

  return (
    <div className="stack">
      <div>
        <h1>Pengaturan</h1>
        <p className="subtitle">Koneksi mailbox, email yang diawasi, jadwal, dan ambang analisis.</p>
      </div>

      {readOnly && (
        <div className="alert warning">
          <span className="icon">!</span>
          <div>Anda membuka aplikasi dari PC lain di jaringan. Pengaturan hanya bisa dilihat; untuk mengubahnya, buka aplikasi di komputer server.</div>
        </div>
      )}

      <form className="stack" onSubmit={save} autoComplete="off">
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="stack">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Koneksi POP3</h2>
              <p>Mailbox hanya dibaca. Email tidak pernah dihapus dari server.</p>
            </div>
          </div>
          <div className="form-grid">
            <label htmlFor="host">Server (host)</label>
            <input id="host" type="text" value={form.pop3_host} onChange={set('pop3_host')} placeholder="mail.gracia.co.id" />
            <label htmlFor="port">Port</label>
            <input id="port" type="number" min="1" max="65535" value={form.pop3_port} onChange={set('pop3_port')} style={{ maxWidth: 120 }} />
            <label>Enkripsi</label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.pop3_tls}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    pop3_tls: e.target.checked,
                    pop3_port: e.target.checked && Number(f.pop3_port) === 110 ? 995 : !e.target.checked && Number(f.pop3_port) === 995 ? 110 : f.pop3_port,
                  }))
                }
              />
              Server memerlukan koneksi terenkripsi (SSL/TLS)
            </label>
            <span className="hint">Umumnya: port 995 dengan SSL/TLS, atau 110 tanpa SSL.</span>
            <label />
            <label className="check">
              <input type="checkbox" checked={form.pop3_allow_invalid_cert} onChange={set('pop3_allow_invalid_cert')} disabled={!form.pop3_tls} />
              Izinkan sertifikat SSL tidak valid
            </label>
            <span className="hint">Hanya aktifkan jika server internal memakai sertifikat buatan sendiri.</span>
            <label htmlFor="user">Username</label>
            <input id="user" type="text" value={form.pop3_username} onChange={set('pop3_username')} placeholder="nama@gracia.co.id" autoComplete="off" />
            <label htmlFor="pass">Password</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                id="pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={form.has_password ? '•••••••• (tersimpan — isi hanya untuk mengganti)' : 'Belum diisi'}
                autoComplete="new-password"
                style={{ flex: 1 }}
              />
              {form.has_password && (
                <button type="button" className="btn danger" onClick={clearPassword}>
                  Hapus
                </button>
              )}
            </div>
            <span className="hint">Disimpan terenkripsi (AES-256-GCM) dan tidak pernah ditampilkan kembali.</span>
            <label />
            <div className="row">
              <button type="button" className="btn" onClick={test} disabled={busy !== null}>
                {busy === 'test' ? 'Menguji…' : 'Tes koneksi'}
              </button>
              <span className="small muted">Memakai isian di atas, termasuk yang belum disimpan.</span>
            </div>
          </div>
          {testMsg && (
            <div style={{ marginTop: 12 }}>
              <Message msg={testMsg} />
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Email yang diawasi</h2>
              <p>Hanya email yang cocok yang diunduh lengkap; yang lain cukup dibaca header-nya.</p>
            </div>
          </div>
          <div className="form-grid">
            <label htmlFor="sender">Alamat pengirim</label>
            <input id="sender" type="text" value={form.watch_sender} onChange={set('watch_sender')} />
            <span className="hint">Dicocokkan dengan alamat email pengirim, bukan nama tampilannya.</span>
            <label htmlFor="subject">Subjek memuat</label>
            <input id="subject" type="text" value={form.watch_subject} onChange={set('watch_subject')} />
            <span className="hint">Cocok jika subjek email memuat teks ini (huruf besar/kecil tidak dibedakan).</span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Jadwal pengambilan</h2>
            </div>
          </div>
          <div className="form-grid">
            <label>Otomatis</label>
            <label className="check">
              <input type="checkbox" checked={form.auto_fetch_enabled} onChange={set('auto_fetch_enabled')} />
              Ambil email otomatis
            </label>
            <label htmlFor="interval">Setiap (menit)</label>
            <input id="interval" type="number" min="1" max="1440" value={form.fetch_interval_minutes} onChange={set('fetch_interval_minutes')} style={{ maxWidth: 120 }} />
            <span className="hint">Default 60, karena report dikirim per jam.</span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Analisis</h2>
            </div>
          </div>
          <div className="form-grid">
            <label htmlFor="internal">Domain internal</label>
            <input id="internal" type="text" value={form.internal_domain} onChange={set('internal_domain')} />
            <span className="hint">Untuk menentukan arah email (masuk/keluar/internal). Subdomain ikut terhitung.</span>
            <label htmlFor="probe">Domain pengecek email</label>
            <textarea id="probe" rows={3} value={form.probe_domains} onChange={set('probe_domains')} />
            <span className="hint">Satu domain per baris. Pengirim dari domain ini (termasuk subdomainnya) ditandai sebagai pengecek.</span>
            <label htmlFor="ratio">Ambang lonjakan</label>
            <div className="row">
              <input id="ratio" type="number" step="0.1" min="1" value={form.spike_ratio} onChange={set('spike_ratio')} style={{ maxWidth: 90 }} />
              <span className="small muted">× rata-rata 7 hari, dan minimal</span>
              <input type="number" min="1" value={form.spike_min_count} onChange={set('spike_min_count')} style={{ maxWidth: 90 }} aria-label="Minimal jumlah" />
              <span className="small muted">email</span>
            </div>
            <label htmlFor="rec">Disebut “berulang” jika muncul di</label>
            <div className="row">
              <input id="rec" type="number" min="2" max="365" value={form.recurring_min_days} onChange={set('recurring_min_days')} style={{ maxWidth: 90 }} />
              <span className="small muted">hari berbeda atau lebih</span>
            </div>
          </div>
        </div>

        <Message msg={msg} />
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy !== null}>
            {busy === 'save' ? 'Menyimpan…' : 'Simpan pengaturan'}
          </button>
        </div>
        </fieldset>
      </form>

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Rules onChanged={onSaved} />
      </fieldset>
    </div>
  );
}

function Rules({ onChanged }) {
  const rules = useApi('/rules');
  const [draft, setDraft] = useState({ category: 'no_such_user', label: '', pattern: '', priority: 100 });
  const [msg, setMsg] = useState(null);

  const run = async (fn, okText) => {
    setMsg(null);
    try {
      const res = await fn();
      setMsg({ kind: 'ok', text: `${okText}${res?.reclassified !== undefined ? ` ${res.reclassified} baris diklasifikasi ulang.` : ''}` });
      rules.reload();
      onChanged?.();
      return true;
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
      return false;
    }
  };

  const cats = rules.data?.categories || [];
  const isNew = draft.category === '__new';
  const labelOf = (code) => cats.find((c) => c.code === code)?.label || code;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Aturan kategori alasan</h2>
          <p>
            Kolom Penyebab dicocokkan dengan pola (regex PostgreSQL, huruf besar/kecil tidak dibedakan). Aturan dengan prioritas terkecil yang
            cocok lebih dulu dipakai; yang tidak cocok masuk “Lainnya”.
          </p>
        </div>
      </div>
      {rules.error && <Message msg={{ kind: 'error', text: rules.error }} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">Prioritas</th>
              <th>Kategori</th>
              <th>Pola</th>
              <th>Aktif</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rules.data?.rules || []).map((r) => (
              <tr key={r.id}>
                <td className="num">{r.priority}</td>
                <td className="small">{labelOf(r.category)}</td>
                <td>
                  <code style={{ wordBreak: 'break-all' }}>{r.pattern}</code>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label="Aktif"
                    onChange={(e) => run(() => api(`/rules/${r.id}`, { method: 'PUT', body: { enabled: e.target.checked } }), 'Aturan diperbarui.')}
                  />
                </td>
                <td>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <button
                      className="btn small"
                      onClick={() => {
                        const pattern = window.prompt('Ubah pola (regex):', r.pattern);
                        if (pattern && pattern !== r.pattern) run(() => api(`/rules/${r.id}`, { method: 'PUT', body: { pattern } }), 'Pola diperbarui.');
                      }}
                    >
                      Ubah
                    </button>
                    <button
                      className="btn small danger"
                      onClick={() => window.confirm('Hapus aturan ini?') && run(() => api(`/rules/${r.id}`, { method: 'DELETE' }), 'Aturan dihapus.')}
                    >
                      Hapus
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ margin: '16px 0 8px' }}>Tambah aturan</h2>
      <div className="row">
        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} aria-label="Kategori">
          {cats.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
          <option value="__new">+ Kategori baru…</option>
        </select>
        {isNew && (
          <>
            <input type="text" placeholder="kode_kategori" value={draft.code || ''} onChange={(e) => setDraft({ ...draft, code: e.target.value })} style={{ width: 160 }} />
            <input type="text" placeholder="Label yang ditampilkan" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </>
        )}
        <input
          type="text"
          placeholder="Pola, mis. greylist|try again later"
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
          style={{ flex: 1, minWidth: 220 }}
        />
        <input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} style={{ width: 90 }} aria-label="Prioritas" />
        <button
          className="btn"
          onClick={() =>
            run(
              () =>
                api('/rules', {
                  method: 'POST',
                  body: { category: isNew ? draft.code : draft.category, label: draft.label, pattern: draft.pattern, priority: Number(draft.priority) },
                }),
              'Aturan ditambahkan.',
            ).then((ok) => ok && setDraft((d) => ({ ...d, pattern: '' })))
          }
        >
          Tambah
        </button>
      </div>
      {msg && (
        <div style={{ marginTop: 12 }}>
          <Message msg={msg} />
        </div>
      )}
    </div>
  );
}
