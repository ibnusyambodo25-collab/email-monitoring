// npm run import-csv -- <file.csv | folder> [...]
// Mengimpor file CSV report secara manual (mis. folder samples/) tanpa lewat POP3.
// File yang isinya sama persis (sha256) tidak diimpor dua kali.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool, withTransaction } from '../db/pool.js';
import { ingestAttachment } from '../ingest/ingest.js';

async function listCsv(target) {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const names = await fs.readdir(target);
  return names.filter((n) => n.toLowerCase().endsWith('.csv')).sort().map((n) => path.join(target, n));
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('Pemakaian: npm run import-csv -- <file.csv | folder> [...]');
  process.exit(1);
}

try {
  const { rows } = await pool.query('SELECT internal_domain FROM settings WHERE id = 1');
  const internalDomain = rows[0].internal_domain;
  for (const target of targets) {
    for (const file of await listCsv(target)) {
      const content = await fs.readFile(file);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const dup = await pool.query(`SELECT id FROM reports WHERE source = 'manual' AND sha256 = $1`, [sha256]);
      if (dup.rows[0]) {
        console.log(`LEWATI  ${file} (sudah pernah diimpor, report #${dup.rows[0].id})`);
        continue;
      }
      const { mtime } = await fs.stat(file);
      const res = await withTransaction((db) =>
        ingestAttachment(db, { source: 'manual', emailDate: mtime, filename: path.basename(file), content, internalDomain }),
      );
      console.log(`IMPOR   ${file} → report #${res.reportId}: ${res.rows} baris, ${res.errors.length} gagal${res.fatal ? ` (${res.fatal})` : ''}`);
      for (const e of res.errors.slice(0, 10)) console.log(`        baris ${e.lineNo ?? '?'}: ${e.message}`);
    }
  }
} catch (err) {
  console.error(`GAGAL: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
