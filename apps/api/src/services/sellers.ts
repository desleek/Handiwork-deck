import type pg from 'pg';
import { type Queryable, one, pool, query } from '../db/pool';
import { HttpError } from '../lib/errors';
import { getSetting } from './settings';

/**
 * Section 10 seller registry, graduated trust:
 *   unlisted (cited in evidence, awaiting admin review) → provisional (evidence approved)
 *   → verified (admin upgrade, or auto after N clean approvals). Admins can flag, remove or merge.
 * Evidence from verified or provisional sellers is accepted automatically; unlisted sellers
 * go to case-by-case admin review; flagged/removed sellers are refused.
 */
export type SellerStatus = 'unlisted' | 'provisional' | 'verified' | 'flagged' | 'removed' | 'merged';
export const ACCEPTED_STATUSES: SellerStatus[] = ['verified', 'provisional'];

export interface NewSellerInput {
  name: string;
  phone?: string;
  address?: string;
  city?: string;
  registrationNumber?: string;
}

/** Follows merge links to the surviving record. */
async function canonical(db: Queryable, id: string) {
  let seller = await one('SELECT * FROM spare_parts_sellers WHERE id = $1', [id], db);
  for (let i = 0; seller?.status === 'merged' && i < 10; i++) seller = await one('SELECT * FROM spare_parts_sellers WHERE id = $1', [seller.merged_into], db);
  return seller;
}

/**
 * Resolves the seller behind an evidence upload: an existing registry entry, or a
 * seller the customer names (matched to an existing record by name + phone, else
 * created as "unlisted" for admin review). Flagged/removed sellers are rejected.
 */
export async function resolveEvidenceSeller(input: { sellerId?: string; newSeller?: NewSellerInput; userId: string }, db: Queryable = pool) {
  let seller: any = null;
  if (input.sellerId) {
    seller = await canonical(db, input.sellerId);
    if (!seller) throw new HttpError(422, 'Unknown seller', 'unverifiable_evidence');
  } else if (input.newSeller) {
    const n = input.newSeller;
    // Same name, and the same phone if both have one (last 10 digits: +234 802… == 0802…).
    seller = await one(
      `SELECT * FROM spare_parts_sellers
        WHERE lower(name) = lower($1) AND ($2::text IS NULL OR phone IS NULL OR right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace($2, '[^0-9]', '', 'g'), 10))
        ORDER BY (status = 'verified') DESC, created_at LIMIT 1`,
      [n.name.trim(), n.phone ?? null],
      db,
    );
    if (seller?.status === 'merged') seller = await canonical(db, seller.id);
    seller ??= await one(
      `INSERT INTO spare_parts_sellers (name, phone, address, city, registration_number, status, created_via, created_by)
       VALUES ($1, $2, $3, $4, $5, 'unlisted', 'evidence', $6) RETURNING *`,
      [n.name.trim(), n.phone ?? null, n.address ?? null, n.city ?? null, n.registrationNumber ?? null, input.userId],
      db,
    );
  } else {
    throw new HttpError(422, 'Name the seller the price evidence comes from', 'unverifiable_evidence');
  }
  if (seller.status === 'flagged' || seller.status === 'removed') {
    throw new HttpError(422, 'Evidence from this seller is not accepted', 'unverifiable_evidence');
  }
  return seller as { id: string; status: SellerStatus; name: string };
}

/** Evidence approved by an admin: unlisted sellers it cites join the registry as provisionally verified. */
export async function promoteEvidenceSellers(db: pg.PoolClient, evidenceFileIds: string[]) {
  await db.query(
    `UPDATE spare_parts_sellers SET status = 'provisional'
      WHERE status = 'unlisted' AND id IN (SELECT seller_id FROM files WHERE id = ANY($1))`,
    [evidenceFileIds],
  );
}

/**
 * A challenge resolved in favour of the customer's evidence counts as a clean
 * approval for each seller cited; with auto-verification on, provisional sellers
 * graduate to verified after the configured number.
 */
export async function recordCleanApproval(db: pg.PoolClient, evidenceFileIds: string[]) {
  const cfg = await getSetting('seller_registry', db);
  const rows = await query<{ id: string; status: SellerStatus; clean_approvals: number }>(
    `UPDATE spare_parts_sellers SET clean_approvals = clean_approvals + 1
      WHERE id IN (SELECT seller_id FROM files WHERE id = ANY($1)) AND status IN ('provisional', 'verified')
      RETURNING id, status, clean_approvals`,
    [evidenceFileIds],
    db,
  );
  if (!cfg.autoVerifyEnabled) return;
  const ready = rows.filter((r) => r.status === 'provisional' && r.clean_approvals >= cfg.cleanApprovalsRequired).map((r) => r.id);
  if (ready.length) {
    await db.query(`UPDATE spare_parts_sellers SET status = 'verified', verified_at = now() WHERE id = ANY($1)`, [ready]);
  }
}
