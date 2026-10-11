import { one, query, type Db } from '../db/pool.ts';
import { consultancySplit, priceBoq, type BoqItemInput, type MilestoneInput, type PricedBoq } from '../domain/construction.ts';
import { splitPayment } from '../domain/pricing.ts';
import type { PlatformSettings } from '../domain/settings.ts';
import { conflict, HttpError, notFound } from '../lib/http.ts';
import { getJob, logJobEvent, setActionRequired, transition, type JobRow } from './jobs.ts';
import { notify } from './notifications/notify.ts';
import { refundPayment } from './payments/escrow.ts';
import { currentContext } from './quotes.ts';
import { postLedger } from './wallet.ts';

/**
 * Construction & plant erection (Section 17): site consultation → BOQ → milestone payments.
 * Money follows the same escrow model as standard jobs: held on payment, released on the event
 * that earns it, with commission computed per milestone.
 */

export async function consultationFor(db: Db, jobId: string) {
  return one<any>('SELECT * FROM site_consultations WHERE job_id = $1', [jobId], db);
}

export async function heldPayment(db: Db, where: { purpose: 'consultancy' | 'milestone'; jobId?: string; milestoneId?: string }) {
  return one<any>(
    `SELECT * FROM payments WHERE purpose = $1 AND status = 'held'
       AND ($2::uuid IS NULL OR job_id = $2) AND ($3::uuid IS NULL OR milestone_id = $3)
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [where.purpose, where.jobId ?? null, where.milestoneId ?? null],
    db,
  );
}

/** Called from the payment layer when a consultancy fee or a milestone is paid (held in escrow). */
export async function onConstructionPaymentHeld(db: Db, p: any): Promise<(() => Promise<void>)[]> {
  const job = await getJob(p.job_id, db, true);
  if (p.purpose === 'consultancy') {
    const c = await consultationFor(db, job.id);
    if (!c || c.status !== 'quoted' || job.status !== 'accepted') {
      await logJobEvent(db, job.id, null, 'payment.late_refund', { paymentId: p.id });
      return [async () => { const { tx } = await import('../db/pool.ts'); await tx((d) => refundPayment(d, p.id, p.amount_minor, 'Consultation no longer awaiting payment')); }];
    }
    await query(`UPDATE site_consultations SET status = 'paid', payment_id = $2 WHERE id = $1`, [c.id, p.id], db);
    const when = c.proposed_visit_at ? new Date(c.proposed_visit_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : 'the agreed time';
    await transition(db, job, 'funded', p.payer_id, { actionFrom: 'technician', actionReason: `Visit the site (${when}) and mark the visit done` });
    return [() => notify({ userId: job.technician_id, type: 'construction.consultation_paid', title: 'Site visit booked', body: `The consultancy fee for job #${job.short_code} is paid. Visit on ${when}.`, data: { jobId: job.id } })];
  }

  // Milestone funded
  const m = await one<any>('SELECT * FROM milestones WHERE id = $1 FOR UPDATE', [p.milestone_id], db);
  if (!m || m.status !== 'pending' || m.total_minor !== p.amount_minor) {
    await logJobEvent(db, job.id, null, 'payment.late_refund', { paymentId: p.id, milestoneId: p.milestone_id });
    return [async () => { const { tx } = await import('../db/pool.ts'); await tx((d) => refundPayment(d, p.id, p.amount_minor, 'Milestone no longer awaiting funding')); }];
  }
  await query(`UPDATE milestones SET status = 'funded', funded_at = now() WHERE id = $1`, [m.id], db);
  if (job.status === 'approved') {
    await transition(db, job, 'in_progress', p.payer_id, { actionFrom: 'technician', actionReason: `Complete milestone ${m.position}: ${m.title}` });
  } else {
    await setActionRequired(db, job.id, 'technician', `Complete milestone ${m.position}: ${m.title}`);
  }
  await logJobEvent(db, job.id, p.payer_id, 'milestone.funded', { milestoneId: m.id, amountMinor: p.amount_minor });
  return [() => notify({ userId: job.technician_id, type: 'construction.milestone_funded', title: `Milestone ${m.position} funded`, body: `"${m.title}" on job #${job.short_code} is funded. You can start.`, data: { jobId: job.id } })];
}

/** Pay the consultancy fee out to the technician (after the visit, minus any configured platform cut). */
export async function releaseConsultancy(db: Db, consultationId: string, s: PlatformSettings, actorId: string | null) {
  const c = await one<any>('SELECT * FROM site_consultations WHERE id = $1 FOR UPDATE', [consultationId], db);
  if (!c || c.status !== 'visited' || !c.payment_id) return false;
  const p = await one<any>(`SELECT * FROM payments WHERE id = $1 AND status = 'held' FOR UPDATE`, [c.payment_id], db);
  if (!p) return false; // already released
  const split = consultancySplit(p.amount_minor, s.consultancyCommissionBps);
  await query(`UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`, [p.id], db);
  await query(
    `INSERT INTO payment_splits (payment_id, recipient, user_id, component, amount_minor) VALUES
       ($1, 'technician', $2, 'consultancy', $3), ($1, 'platform', NULL, 'consultancy_commission', $4)`,
    [p.id, c.technician_id, split.technicianMinor, split.commissionMinor],
    db,
  );
  await query(`UPDATE site_consultations SET commission_minor = $2 WHERE id = $1`, [c.id, split.commissionMinor], db);
  await postLedger(db, { userId: c.technician_id, type: 'earning', amountMinor: split.technicianMinor, description: 'Site consultation fee', paymentId: p.id, jobId: c.job_id });
  await logJobEvent(db, c.job_id, actorId, 'consultancy.released', split);
  return true;
}

// ------------------------------------------------------------------------------- BOQ

export interface BoqSubmission {
  items: BoqItemInput[];
  milestones: MilestoneInput[];
  notes?: string;
}

export async function priceForJob(db: Db, job: JobRow, sub: BoqSubmission, s: PlatformSettings): Promise<{ priced: PricedBoq; frozen: any }> {
  const { frozen } = await currentContext(db, job.technician_id, s);
  const priced = priceBoq(sub.items, sub.milestones, { ...frozen }, s.maxMilestones);
  return { priced, frozen };
}

export function assertBoqValid(priced: PricedBoq) {
  if (priced.issues.length) throw new HttpError(422, 'BOQ_INVALID', 'The BOQ breaks pricing rules', priced.issues);
}

/** Persist a new BOQ version with its lines and proposed milestones. Older versions are superseded. */
export async function saveBoqVersion(
  db: Db,
  p: {
    job: JobRow;
    draftId?: string;
    source: 'builder' | 'excel' | 'pdf' | 'word';
    sourceFileUrl?: string | null;
    sub: BoqSubmission;
    priced: PricedBoq;
    frozen: { multiplierBps: number; markupCapBps: number; laborCommissionBps: number; markupCommissionBps: number };
  },
) {
  const { job, priced, frozen } = p;
  await query(`UPDATE boqs SET status = 'superseded' WHERE job_id = $1 AND status IN ('submitted', 'negotiating')`, [job.id], db);
  await query(`UPDATE milestones SET status = 'cancelled' WHERE job_id = $1 AND status = 'proposed'`, [job.id], db);

  let boqId = p.draftId;
  if (boqId) {
    const d = await one<any>(`SELECT * FROM boqs WHERE id = $1 AND job_id = $2 AND status = 'draft' FOR UPDATE`, [boqId, job.id], db);
    if (!d) throw notFound('Draft BOQ');
    await query('DELETE FROM boq_items WHERE boq_id = $1', [boqId], db);
  } else {
    const v = await one<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM boqs WHERE job_id = $1', [job.id], db);
    const row = await one<{ id: string }>(
      `INSERT INTO boqs (job_id, version, source, source_file_url, technician_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [job.id, v!.v, p.source, p.sourceFileUrl ?? null, job.technician_id],
      db,
    );
    boqId = row!.id;
  }
  const t = priced.totals;
  await query(
    `UPDATE boqs SET status = 'submitted', submitted_at = now(), notes = $2,
       parse_status = CASE WHEN source = 'builder' THEN 'not_applicable' ELSE 'reviewed' END,
       applied_multiplier_bps = $3, markup_cap_bps = $4, labor_commission_bps = $5, markup_commission_bps = $6,
       labor_total_minor = $7, materials_total_minor = $8, markup_total_minor = $9, grand_total_minor = $10
     WHERE id = $1`,
    [boqId, p.sub.notes ?? null, frozen.multiplierBps, frozen.markupCapBps, frozen.laborCommissionBps, frozen.markupCommissionBps,
      t.laborTotalMinor, t.partsBaseTotalMinor, t.markupTotalMinor, t.customerTotalMinor],
    db,
  );
  for (const l of priced.lines) {
    await query(
      `INSERT INTO boq_items (boq_id, kind, description, unit, quantity, unit_rate_minor, base_labor_minor, markup_bps, markup_minor,
          line_total_minor, milestone_position, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [boqId, l.kind, l.description, l.unit, l.quantity, l.unitCostMinor, l.baseLaborMinor, l.markupBps, l.markupMinor, l.lineTotalMinor, l.milestone, l.position],
      db,
    );
  }
  for (const m of priced.milestones) {
    await query(
      `INSERT INTO milestones (job_id, boq_id, title, position, labor_minor, parts_base_minor, markup_minor, labor_commission_minor,
          markup_commission_minor, technician_net_minor, total_minor, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'proposed')`,
      [job.id, boqId, m.title, m.position, m.totals.laborTotalMinor, m.totals.partsBaseTotalMinor, m.totals.markupTotalMinor,
        m.totals.laborCommissionMinor, m.totals.markupCommissionMinor, m.totals.technicianNetMinor, m.totals.customerTotalMinor],
      db,
    );
  }
  return boqId!;
}

/** Release a funded milestone on customer confirmation: per-milestone split into the technician's wallet. */
export async function releaseMilestone(db: Db, milestoneId: string, actorId: string, opts: { refundMinor?: number } = {}) {
  const m = await one<any>('SELECT * FROM milestones WHERE id = $1 FOR UPDATE', [milestoneId], db);
  if (!m) throw notFound('Milestone');
  if (!['funded', 'awaiting_confirmation', 'disputed'].includes(m.status)) throw conflict('NOT_RELEASABLE', `Milestone is ${m.status}`);
  const p = await heldPayment(db, { purpose: 'milestone', milestoneId });
  if (!p) throw conflict('NOT_FUNDED', 'No held payment for this milestone');

  let totals = {
    laborTotalMinor: m.labor_minor,
    partsBaseTotalMinor: m.parts_base_minor,
    markupTotalMinor: m.markup_minor,
    customerTotalMinor: m.total_minor,
    laborCommissionMinor: m.labor_commission_minor,
    markupCommissionMinor: m.markup_commission_minor,
    platformCommissionMinor: m.labor_commission_minor + m.markup_commission_minor,
    technicianNetMinor: m.technician_net_minor,
  };
  const refund = opts.refundMinor ?? 0;
  if (refund > 0) {
    // Dispute adjustment: refund comes off labor first (then materials), commission recomputed on what's left.
    if (refund >= m.total_minor) throw conflict('REFUND_TOO_LARGE', 'Use a full refund instead');
    await refundPayment(db, p.id, refund, `Milestone ${m.position} adjustment`);
    await query(`UPDATE payments SET status = 'held', amount_minor = amount_minor - $2 WHERE id = $1`, [p.id, refund], db);
    const fromLabor = Math.min(refund, totals.laborTotalMinor);
    const labor = totals.laborTotalMinor - fromLabor;
    const parts = totals.partsBaseTotalMinor - (refund - fromLabor);
    const b = await one<any>('SELECT labor_commission_bps FROM boqs WHERE id = $1', [m.boq_id], db);
    const laborCommission = Math.round((labor * (b?.labor_commission_bps ?? 0)) / 10_000);
    totals = {
      ...totals,
      laborTotalMinor: labor,
      partsBaseTotalMinor: parts,
      customerTotalMinor: m.total_minor - refund,
      laborCommissionMinor: laborCommission,
      platformCommissionMinor: laborCommission + totals.markupCommissionMinor,
      technicianNetMinor: m.total_minor - refund - laborCommission - totals.markupCommissionMinor,
    };
    await logJobEvent(db, m.job_id, actorId, 'milestone.adjusted', { milestoneId, refund });
  }

  const job = await getJob(m.job_id, db, true);
  const splits = splitPayment(totals);
  for (const sp of splits) {
    await query(
      `INSERT INTO payment_splits (payment_id, recipient, user_id, component, amount_minor) VALUES ($1,$2,$3,$4,$5)`,
      [p.id, sp.recipient, sp.recipient === 'technician' ? job.technician_id : null, sp.component, sp.amountMinor],
      db,
    );
  }
  const techTotal = splits.filter((s) => s.recipient === 'technician').reduce((a, s) => a + s.amountMinor, 0);
  await postLedger(db, { userId: job.technician_id, type: 'earning', amountMinor: techTotal, description: `Milestone ${m.position}: ${m.title} (#${job.short_code})`, paymentId: p.id, jobId: job.id });
  await query(`UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`, [p.id], db);
  await query(`UPDATE milestones SET status = 'released', released_at = now(), confirmed_at = now() WHERE id = $1`, [m.id], db);
  await logJobEvent(db, job.id, actorId, 'milestone.released', { milestoneId: m.id, splits });

  // Next step for the job
  const rest = await query<{ position: number; status: string; title: string }>(
    `SELECT position, status, title FROM milestones WHERE boq_id = $1 AND status NOT IN ('cancelled') ORDER BY position`,
    [m.boq_id],
    db,
  );
  const remaining = rest.filter((r) => r.status !== 'released' && r.status !== 'refunded');
  if (remaining.length === 0) {
    if (job.status === 'disputed') await transition(db, job, 'in_progress', actorId, { actionFrom: 'none', actionReason: '' });
    await transition(db, job, 'completed', actorId, { actionFrom: 'none', actionReason: '' });
  } else {
    const next = remaining[0];
    if (job.status === 'disputed') await transition(db, job, 'in_progress', actorId, { actionFrom: 'customer', actionReason: `Fund milestone ${next.position}: ${next.title}` });
    const who = next.status === 'pending' ? 'customer' : 'technician';
    await setActionRequired(db, job.id, who, who === 'customer' ? `Fund milestone ${next.position}: ${next.title}` : `Complete milestone ${next.position}: ${next.title}`);
  }
  return { job, milestone: m, technicianMinor: techTotal, completed: remaining.length === 0 };
}
