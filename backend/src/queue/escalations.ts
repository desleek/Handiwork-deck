import { one, query, tx } from '../db/pool.ts';
import { AWAITING_TECHNICIAN, finalActionStatus, type EscalationAction } from '../domain/escalation.ts';
import { getJob, logJobEvent, setActionRequired, transition } from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { resolveChallengeInCustomerFavour } from '../services/priceChallenges.ts';
import { getSettings } from '../services/settings.ts';

/** One step of the Section 6c timeline. Safe to run late, twice, or after the technician responded. */
export async function runEscalationStep(challengeId: string, step: EscalationAction) {
  const c = await one<any>(`SELECT pc.*, j.short_code FROM price_challenges pc JOIN jobs j ON j.id = pc.job_id WHERE pc.id = $1`, [challengeId]);
  if (!c || !AWAITING_TECHNICIAN.has(c.status)) return { skipped: true };
  const urgent = c.is_fast_track;
  const tag = urgent ? '⚡ URGENT ' : '';

  if (step.type === 'notify_technician') {
    await notify({
      userId: c.technician_id,
      type: 'price_challenge.reminder',
      title: `${tag}Price challenge on job #${c.short_code}`,
      body:
        step.reason === 'submitted'
          ? 'A customer challenged a parts price. Match it, explain the difference, or hold firm.'
          : 'Reminder: a customer is waiting for your response to a parts price challenge.',
      data: { jobId: c.job_id, challengeId },
      urgent,
    });
    await query('UPDATE price_challenges SET notifications_sent = notifications_sent + 1 WHERE id = $1', [challengeId]);
    return { notified: true };
  }

  if (step.type === 'escalate_to_admin') {
    await tx(async (db) => {
      await query(`UPDATE price_challenges SET status = 'escalated', escalated_at = now() WHERE id = $1 AND status = 'open'`, [challengeId], db);
      await logJobEvent(db, c.job_id, null, 'price_challenge.escalated', { challengeId, fastTrack: urgent });
    });
    // Email + WhatsApp to the technician; the admin queue shows it (Fast Track visually flagged).
    await notify({
      userId: c.technician_id,
      type: 'price_challenge.escalated',
      title: `${tag}Price challenge escalated — job #${c.short_code}`,
      body: 'This challenge has been escalated to Handiwork-Deck support. Respond now to avoid an automatic decision.',
      data: { jobId: c.job_id, challengeId },
      channels: ['push', 'whatsapp', 'email'],
      whatsappTemplate: { name: 'price_challenge_escalated', params: [c.short_code] },
      urgent: true,
    });
    return { escalated: true };
  }

  // Final automatic action — a uniform global rule, never case-by-case.
  const s = await getSettings();
  const outcome = finalActionStatus(s.priceChallengeFinalAction);
  await tx(async (db) => {
    const fresh = await one<any>('SELECT * FROM price_challenges WHERE id = $1 FOR UPDATE', [challengeId], db);
    if (!fresh || !AWAITING_TECHNICIAN.has(fresh.status)) return;
    if (outcome === 'auto_approved') {
      await resolveChallengeInCustomerFavour(db, fresh, null, 'auto_approved');
    } else {
      await query(
        `UPDATE price_challenges SET status = 'auto_cancelled', resolved_at = now(), final_action = 'auto_cancel_redirect_labor_only' WHERE id = $1`,
        [challengeId],
        db,
      );
      const job = await getJob(fresh.job_id, db, true);
      await setActionRequired(db, job.id, 'customer', 'Price challenge closed — continue with labor only or cancel');
      if (job.status !== 'negotiating') await transition(db, job, 'negotiating', null, { actionFrom: 'customer', actionReason: 'Price challenge closed' });
      await logJobEvent(db, job.id, null, 'price_challenge.auto_cancelled', { challengeId });
    }
  });
  await notify({ userId: c.customer_id, type: 'price_challenge.final', title: `Price challenge resolved — job #${c.short_code}`, body: outcome === 'auto_approved' ? 'The technician did not respond, so your price evidence was applied to the quote.' : 'The technician did not respond. You can continue with a labor-only booking.', data: { jobId: c.job_id } });
  await notify({ userId: c.technician_id, type: 'price_challenge.final', title: `Price challenge closed — job #${c.short_code}`, body: 'No response was received in time, so the automatic rule was applied.', data: { jobId: c.job_id } });
  return { final: outcome };
}
