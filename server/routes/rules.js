import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { ValidationError } from '../settings.js';
import { logEvent } from '../events.js';

// Aturan pengelompokan kolom Penyebab (regex PostgreSQL) yang bisa diubah dari GUI.
// Setiap perubahan langsung mengklasifikasi ulang seluruh data.

export const rulesRouter = Router();

async function validatePattern(pattern) {
  const p = String(pattern || '').trim();
  if (!p) throw new ValidationError('Pola tidak boleh kosong.');
  try {
    await query(`SELECT '' ~* $1`, [p]);
  } catch (err) {
    throw new ValidationError(`Pola regex tidak valid: ${err.message}`);
  }
  return p;
}

function validatePriority(v) {
  const n = Number(v ?? 100);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new ValidationError('Prioritas harus bilangan bulat 0–9999.');
  return n;
}

async function reclassify() {
  const { rows } = await query('SELECT classify_rejections() AS n');
  return rows[0].n;
}

rulesRouter.get('/rules', async (_req, res) => {
  const [cats, rules] = await Promise.all([
    query(
      `SELECT c.code, c.label, c.sort_order,
              (SELECT count(*)::int FROM rejections r WHERE r.reason_category = c.code) AS row_count
         FROM reason_categories c ORDER BY c.sort_order, c.code`,
    ),
    query('SELECT id, category, pattern, priority, enabled FROM reason_rules ORDER BY priority, id'),
  ]);
  res.json({ categories: cats.rows, rules: rules.rows });
});

rulesRouter.post('/rules', async (req, res) => {
  const b = req.body || {};
  const pattern = await validatePattern(b.pattern);
  const priority = validatePriority(b.priority);
  const category = String(b.category || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(category)) {
    throw new ValidationError('Kode kategori hanya boleh huruf kecil, angka, dan garis bawah (2–40 karakter).');
  }
  await withTransaction(async (db) => {
    const exists = await db.query('SELECT 1 FROM reason_categories WHERE code = $1', [category]);
    if (!exists.rows[0]) {
      const label = String(b.label || '').trim();
      if (!label) throw new ValidationError('Kategori baru perlu label (nama yang ditampilkan).');
      await db.query('INSERT INTO reason_categories (code, label, sort_order) VALUES ($1, $2, $3)', [category, label, priority]);
    }
    await db.query('INSERT INTO reason_rules (category, pattern, priority) VALUES ($1, $2, $3)', [category, pattern, priority]);
  }).catch((err) => {
    if (err.code === '23505') throw new ValidationError('Aturan dengan kategori dan pola yang sama sudah ada.');
    throw err;
  });
  const n = await reclassify();
  await logEvent('info', `Aturan kategori ditambahkan (${category}). ${n} baris diklasifikasi ulang.`);
  res.status(201).json({ reclassified: n });
});

rulesRouter.put('/rules/:id', async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const params = [];
  const set = (column, value) => {
    params.push(value);
    sets.push(`${column} = ${params.length}`);
  };
  if (b.pattern !== undefined) set('pattern', await validatePattern(b.pattern));
  if (b.priority !== undefined) set('priority', validatePriority(b.priority));
  if (b.enabled !== undefined) set('enabled', Boolean(b.enabled));
  if (b.category !== undefined) set('category', String(b.category));
  if (!sets.length) throw new ValidationError('Tidak ada yang diubah.');
  params.push(Number(req.params.id));
  const { rowCount } = await query(`UPDATE reason_rules SET ${sets.join(', ')} WHERE id = $${params.length}`, params).catch((err) => {
    if (err.code === '23503') throw new ValidationError('Kategori tidak ditemukan.');
    if (err.code === '23505') throw new ValidationError('Aturan dengan kategori dan pola yang sama sudah ada.');
    throw err;
  });
  if (!rowCount) return res.status(404).json({ error: 'Aturan tidak ditemukan.' });
  res.json({ reclassified: await reclassify() });
});

rulesRouter.delete('/rules/:id', async (req, res) => {
  const { rowCount } = await query('DELETE FROM reason_rules WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Aturan tidak ditemukan.' });
  res.json({ reclassified: await reclassify() });
});

rulesRouter.put('/categories/:code', async (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) throw new ValidationError('Label tidak boleh kosong.');
  const { rowCount } = await query('UPDATE reason_categories SET label = $1 WHERE code = $2', [label, req.params.code]);
  if (!rowCount) return res.status(404).json({ error: 'Kategori tidak ditemukan.' });
  res.json({ ok: true });
});

rulesRouter.post('/rules/reclassify', async (_req, res) => {
  res.json({ reclassified: await reclassify() });
});
