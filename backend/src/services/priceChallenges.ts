import { one, query, type Db } from '../db/pool.ts';
import { applyChallengedPrice } from '../domain/pricing.ts';
import { getJob, logJobEvent, setActionRequired, transition } from './jobs.ts';
import { approvedExceptionCaps, assertPriceable, frozenOf, insertQuote, itemsToInputs, liveQuote, price, quoteItems } from './quotes.ts';
import { getSettings } from './settings.ts';

/**
 * Apply the customer's verified price to the challenged line and issue a revised quote version.
 * Used when the technician matches the price, and by the Hour-72 / Hour-24 automatic rule.
 * The seller earns a clean approval (graduated trust, Section 10).
 */
export async function resolveChallengeInCustomerFavour(db: Db, challenge: any, actorId: string | null, status: 'matched' | 'auto_approved') {
  const s = await getSettings();
  const quote = await liveQuote(db, challenge.job_id);
  const items = await quoteItems(db, quote.id);
  const item = items.find((i) => i.id === challenge.quote_item_id);
  if (item && quote.id === challenge.quote_id && quote.status === 'submitted') {
    const caps = await approvedExceptionCaps(db, challenge.job_id);
    const inputs = applyChallengedPrice(itemsToInputs(items, caps), item.position, challenge.claimed_unit_cost_minor);
    const priced = price(inputs, frozenOf(quote), s.receiptThresholdMinor);
    // The evidence itself is the proof of price, so a receipt is no longer required on that line.
    priced.issues = priced.issues.filter((i) => !(i.code === 'RECEIPT_REQUIRED' && i.position === item.position));
    assertPriceable(priced, false);
    await insertQuote(db, {
      jobId: challenge.job_id,
      technicianId: challenge.technician_id,
      status: 'submitted',
      frozen: frozenOf(quote),
      lines: priced.lines,
      totals: priced.totals,
      notes: quote.notes,
      laborOnly: quote.labor_only,
    });
  }
  await query(
    `UPDATE price_challenges SET status = $2::challenge_status, resolved_at = now(), final_action = $3,
       responded_at = COALESCE(responded_at, CASE WHEN $2::text = 'matched' THEN now() END) WHERE id = $1`,
    [challenge.id, status, status === 'auto_approved' ? 'auto_approve_customer_evidence' : 'technician_matched'],
    db,
  );
  if (challenge.seller_id) await creditSeller(db, challenge.seller_id);
  const job = await getJob(challenge.job_id, db, true);
  if (job.status === 'negotiating') await transition(db, job, 'quoted', actorId, { event: { challengeId: challenge.id } });
  else await setActionRequired(db, job.id, 'customer', 'Review the revised quote');
  await logJobEvent(db, job.id, actorId, `price_challenge.${status}`, { challengeId: challenge.id });
}

/** Clean approval for a seller; auto-upgrade provisional → verified at the configured threshold. */
export async function creditSeller(db: Db, sellerId: string) {
  const s = await getSettings();
  await query(
    `UPDATE parts_sellers SET clean_approvals = clean_approvals + 1, updated_at = now(),
       verification_status = CASE
         WHEN verification_status = 'provisional' AND clean_approvals + 1 >= $2 THEN 'verified'::seller_verification
         ELSE verification_status END
     WHERE id = $1`,
    [sellerId, s.sellerAutoVerifyAfterCleanApprovals],
    db,
  );
}

/** Evidence from a seller not yet in the registry, once admin accepts it: seller becomes provisionally verified. */
export async function addOrganicSeller(db: Db, name: string): Promise<string> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM parts_sellers WHERE lower(name) = lower($1) AND merged_into IS NULL AND verification_status <> 'removed'`,
    [name],
    db,
  );
  if (existing) return existing.id;
  const row = await one<{ id: string }>(
    `INSERT INTO parts_sellers (name, verification_status, source) VALUES ($1, 'provisional', 'organic') RETURNING id`,
    [name],
    db,
  );
  return row!.id;
}
