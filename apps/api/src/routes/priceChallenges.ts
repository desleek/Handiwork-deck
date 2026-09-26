import { CHALLENGE_RESPONSES } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { audit } from '../services/audit';
import { applyChallengedPrices, notifyTechnicianOfChallenge, scheduleChallenge, timelineFor } from '../services/priceChallenges';
import { recordCleanApproval } from '../services/sellers';
import { loadJobFor } from './jobs';

/**
 * Section 6c: price challenges on parts, pre-job. The customer must back each
 * challenge with an invoice / price proof from a verified registry seller. The
 * technician matches, explains, or holds firm; unanswered challenges escalate
 * on a fixed timeline (standard 72h, Fast Track 24h).
 */
export const priceChallengesRouter = Router();

/** Registry sellers customers can cite as evidence: verified first, then provisionally verified (Section 10). */
priceChallengesRouter.get('/sellers', authenticate, requireUser(), async (req, res) => {
  const { q, categoryId } = parse(z.object({ q: z.string().trim().max(80).optional(), categoryId: z.coerce.number().int().positive().optional() }), req.query);
  const sellers = await query(
    `SELECT id, name, city, address, status FROM spare_parts_sellers
      WHERE status IN ('verified', 'provisional') AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
        AND ($2::int IS NULL OR cardinality(category_ids) = 0 OR $2 = ANY(category_ids))
      ORDER BY (status = 'verified') DESC, name LIMIT 50`,
    [q ?? null, categoryId ?? null],
  );
  res.json({ sellers });
});

const ChallengeBody = z.object({
  lines: z.array(z.object({ itemId: z.uuid(), proposedUnitPriceMinor: z.number().int().min(0) })).min(1).max(50),
  /** Files uploaded with kind `price_evidence` (each tied to a verified seller at upload). */
  evidenceFileIds: z.array(z.uuid()).min(1).max(10),
  message: z.string().trim().max(2000).optional(),
  /** Urgent job: the whole timeline compresses into 24 hours. */
  fastTrack: z.boolean().default(false),
});

priceChallengesRouter.post('/jobs/:id/quotes/:quoteId/price-challenges', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const quoteId = parse(z.uuid(), req.params.quoteId);
  const b = parse(ChallengeBody, req.body);
  const customer = currentUser(req);

  const evidence = await query<{ id: string; status: string | null }>(
    `SELECT f.id, s.status FROM files f LEFT JOIN spare_parts_sellers s ON s.id = f.seller_id
      WHERE f.id = ANY($1) AND f.owner_id = $2 AND f.kind = 'price_evidence'`,
    [b.evidenceFileIds, customer.id],
  );
  if (evidence.length !== new Set(b.evidenceFileIds).size || evidence.some((e) => !e.status || ['flagged', 'removed', 'merged'].includes(e.status))) {
    throw new HttpError(422, 'Evidence must be an invoice or price proof from a named, accepted seller', 'unverifiable_evidence');
  }
  // Section 10: a seller not yet in the registry means case-by-case admin review first — not rejection.
  const needsReview = evidence.some((e) => e.status === 'unlisted');

  const { challenge, q } = await tx(async (db) => {
    const q = await one(
      `SELECT q.*, j.customer_id, j.status AS job_status, j.ref AS job_ref FROM quotes q JOIN jobs j ON j.id = q.job_id
        WHERE q.id = $1 AND q.job_id = $2 FOR UPDATE OF q`,
      [quoteId, jobId],
      db,
    );
    if (!q) throw notFound('Quote');
    if (q.customer_id !== customer.id) throw forbidden('Not your job');
    if (!['open', 'quoted'].includes(q.job_status)) throw conflict('Price challenges are only possible before the job starts');
    if (q.status !== 'pending') throw conflict(q.status === 'countered' ? 'A negotiation is already open on this quote' : `Quote is ${q.status}`);

    const items = await query(`SELECT id, kind, description, unit_price_minor FROM quote_items WHERE quote_id = $1`, [quoteId], db);
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const l of b.lines) {
      const item = byId.get(l.itemId);
      if (!item || item.kind !== 'material') throw badRequest('Price challenges apply to part / material lines only');
      if (l.proposedUnitPriceMinor >= Number(item.unit_price_minor)) throw badRequest(`Your price for "${item.description}" must be lower than the quoted base cost`);
    }
    const t = await timelineFor(b.fastTrack);
    const challenge = await one(
      `INSERT INTO price_challenges (job_id, quote_id, quote_revision, customer_id, technician_id, fast_track, message, evidence_file_ids,
                                     response_due_at, final_action_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9), now() + make_interval(secs => $10), $11) RETURNING *`,
      [
        jobId, quoteId, q.revision, customer.id, q.technician_id, b.fastTrack, b.message ?? null, b.evidenceFileIds,
        t.responseDueHours * 3600, t.finalActionHours * 3600, needsReview ? 'pending_review' : 'pending',
      ],
      db,
    );
    for (const l of b.lines) {
      const item = byId.get(l.itemId)!;
      await db.query(
        'INSERT INTO price_challenge_lines (challenge_id, quote_item_id, description, current_unit_price_minor, proposed_unit_price_minor) VALUES ($1, $2, $3, $4, $5)',
        [challenge.id, l.itemId, item.description, item.unit_price_minor, l.proposedUnitPriceMinor],
      );
    }
    await db.query(`UPDATE quotes SET status = 'countered' WHERE id = $1`, [quoteId]);
    await audit(jobId, customer.id, 'price_challenge.submitted', { challengeId: challenge.id, fastTrack: b.fastTrack, lines: b.lines, evidenceFileIds: b.evidenceFileIds, message: b.message ?? null, evidenceReview: needsReview }, db);
    return { challenge, q };
  });
  if (needsReview) {
    const admins = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND is_active`);
    await Promise.all(
      admins.map((a) =>
        scheduler().notify(a.id, { title: 'Price evidence to review', body: `#${q.job_ref}: evidence cites a seller not in the registry`, data: { jobId, type: 'price_challenge.evidence_review' } }),
      ),
    );
    res.status(201).json({ challenge });
    return;
  }
  await scheduleChallenge(challenge.id, b.fastTrack);
  await notifyTechnicianOfChallenge(challenge.id);
  res.status(201).json({ challenge });
});

priceChallengesRouter.get('/jobs/:id/price-challenges', authenticate, requireUser(), async (req, res) => {
  const user = currentUser(req);
  const job = await loadJobFor(parse(z.uuid(), req.params.id), user.id, user.role);
  const challenges = await query(
    `SELECT pc.*,
            (SELECT json_agg(l) FROM price_challenge_lines l WHERE l.challenge_id = pc.id) AS lines,
            (SELECT json_agg(json_build_object('id', f.id, 'url', f.url, 'seller', s.name)) FROM files f JOIN spare_parts_sellers s ON s.id = f.seller_id
              WHERE f.id = ANY(pc.evidence_file_ids)) AS evidence
       FROM price_challenges pc WHERE pc.job_id = $1 AND ($2 OR pc.technician_id = $3) ORDER BY pc.created_at DESC`,
    [job.id, job.customer_id === user.id || user.role === 'admin', user.id],
  );
  res.json({ challenges });
});

const RespondBody = z.object({ response: z.enum(CHALLENGE_RESPONSES), message: z.string().trim().max(2000).optional() });

/** Technician: match the evidenced price, explain the discrepancy, or hold firm. */
priceChallengesRouter.post('/price-challenges/:id/respond', authenticate, requireUser('technician'), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(RespondBody, req.body);
  const tech = currentUser(req);
  if (b.response === 'explain' && !b.message) throw badRequest('Explain the price difference (message)');
  const c = await tx(async (db) => {
    const c = await one(`SELECT * FROM price_challenges WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) throw notFound('Price challenge');
    if (c.technician_id !== tech.id) throw forbidden();
    if (c.status !== 'pending') throw conflict(`Challenge is already ${c.status}`);
    await db.query('SELECT 1 FROM quotes WHERE id = $1 FOR UPDATE', [c.quote_id]);
    if (b.response === 'match') {
      await applyChallengedPrices(db, id);
      await recordCleanApproval(db, c.evidence_file_ids);
    }
    const status = { match: 'matched', explain: 'explained', hold_firm: 'held_firm' }[b.response];
    await db.query(`UPDATE price_challenges SET status = $2, technician_response = $3, responded_at = now(), resolved_at = now() WHERE id = $1`, [id, status, b.message ?? null]);
    await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1 AND status = 'countered'`, [c.quote_id]);
    await audit(c.job_id, tech.id, `price_challenge.${status}`, { challengeId: id, message: b.message ?? null }, db);
    return c;
  });
  const body = {
    match: `${tech.full_name} matched your evidenced prices. Review the updated quote.`,
    explain: `${tech.full_name} explained their parts prices: "${b.message ?? ''}"`,
    hold_firm: `${tech.full_name} is holding their parts prices. You can approve the quote, send a labor-only request, or choose another technician.`,
  }[b.response];
  await scheduler().notify(c.customer_id, { title: 'Price challenge answered', body, data: { jobId: c.job_id, type: 'price_challenge.answered' } });
  res.json({ ok: true });
});

priceChallengesRouter.post('/price-challenges/:id/withdraw', authenticate, requireUser('customer'), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const user = currentUser(req);
  await tx(async (db) => {
    const c = await one(
      `UPDATE price_challenges SET status = 'withdrawn', resolved_at = now() WHERE id = $1 AND customer_id = $2 AND status IN ('pending', 'pending_review') RETURNING *`,
      [id, user.id],
      db,
    );
    if (!c) throw conflict('No open challenge to withdraw');
    await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1 AND status = 'countered'`, [c.quote_id]);
    await audit(c.job_id, user.id, 'price_challenge.withdrawn', { challengeId: id }, db);
  });
  res.json({ ok: true });
});
