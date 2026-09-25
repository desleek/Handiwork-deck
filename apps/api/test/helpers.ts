import { pool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';

export async function dbAvailable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Fresh schema for every test file. */
export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await pool.query(`INSERT INTO service_categories (slug, name, segment) VALUES
    ('plumbing', 'Plumbing', 'household_office'),
    ('steel-erection', 'Steel & Plant Erection', 'construction_plant')`);
}

export const bearer = (uid: string, phone?: string) => `Bearer dev:${uid}${phone ? `:${phone}` : ''}`;
