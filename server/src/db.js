import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from './config.js';

// NUMERIC -> JS number (values here stay well within double precision)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export function createPool(connectionString = config.databaseUrl) {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function migrate(pool) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export { tx } from './tx.js';
