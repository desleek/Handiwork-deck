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
  await migrate(); // also loads the launch taxonomy
}

export async function categoryId(slug: string): Promise<number> {
  const r = await pool.query('SELECT id FROM service_categories WHERE slug = $1', [slug]);
  return r.rows[0].id;
}

/** A single-line labor quote, the simplest valid itemized quote. */
export const laborQuote = (amountMinor: number, extra: Record<string, unknown> = {}) => ({
  items: [{ kind: 'labor', description: 'Labor', quantity: 1, unitPriceMinor: amountMinor }],
  ...extra,
});

export const fullScores = (n = 5) => ({ competence: n, punctuality: n, professionalism: n, courtesy: n, timeline: n, transparency: n, quality: n });

export const bearer = (uid: string, phone?: string) => `Bearer dev:${uid}${phone ? `:${phone}` : ''}`;

/**
 * Suites written before Section 11 pay once the job is completed (paying then
 * counts as confirming, so escrow is funded and captured in one step). The
 * funding-before-start gate is exercised in escrow-ads.test.ts.
 */
export async function payOnCompletion() {
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('escrow', '{"requireFundingBeforeStart": false, "autoReleaseHours": 48}')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
}
