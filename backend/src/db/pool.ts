import pg from 'pg';
import { env } from '../config/env.ts';

// BIGINT (int8) money columns: parse to JS number. Safe up to ~₦90 trillion in kobo.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC (ratings, quantities)
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T | undefined> {
  const rows = await query<T>(text, params, db);
  return rows[0];
}

/** Run fn inside a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
