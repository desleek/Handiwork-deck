import { query, type Db } from '../db/pool.ts';
import { isRestricted } from '../domain/penalties.ts';
import { forbidden } from '../lib/http.ts';

export async function activeRestrictions(userId: string, db?: Db) {
  const rows = await query<{ id: string; tier: number; restricted_functions: string[]; starts_at: Date; ends_at: Date | null; lifted_at: Date | null }>(
    `SELECT id, tier, restricted_functions, starts_at, ends_at, lifted_at FROM account_restrictions
      WHERE user_id = $1 AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > now())`,
    [userId],
    db,
  );
  return rows.map((r) => ({ id: r.id, tier: r.tier, restrictedFunctions: r.restricted_functions, startsAt: r.starts_at, endsAt: r.ends_at, liftedAt: r.lifted_at }));
}

/** Section 18 penalties: throws 403 if the function is currently restricted for this user. */
export async function assertAllowed(userId: string, fn: string, db?: Db) {
  if (isRestricted(await activeRestrictions(userId, db), fn, new Date())) {
    throw forbidden('ACCOUNT_RESTRICTED', 'This action is temporarily restricted on your account. You can still finish jobs in progress.');
  }
}
