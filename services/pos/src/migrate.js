import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'migrations');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(JSON.stringify({ event: 'migration_applied', file }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(JSON.stringify({ event: 'migrations_complete', count: files.length }));
} finally {
  await pool.end();
}
