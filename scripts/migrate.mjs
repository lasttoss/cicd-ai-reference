// Idempotent migration runner. Safe to run on every deploy.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'migrations');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  if (applied.has(file)) { console.log(`skip ${file}`); continue; }
  const sql = await readFile(join(dir, file), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied ${file}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED ${file}: ${e.message}`);
    process.exit(1);
  } finally { client.release(); }
}
await pool.end();
