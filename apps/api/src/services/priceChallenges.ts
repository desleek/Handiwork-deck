import { challengeSchedule, type ChallengeTimeline, priceLine } from '@handiwork/shared';
import type pg from 'pg';
import { one, query, tx } from '../db/pool';
import { logger } from '../lib/logger';
import { type ChallengeStepData, jobs } from '../queues/index';
import { audit } from './audit';
import { refreshQuoteTotals } from './jobs/quotes';
import { whatsapp } from './messaging/whatsapp';
import { email } from './notifications/email';
import { getSetting } from './settings';

const HOUR = 3_600_000;

export async function timelineFor(fastTrack: boolean): Promise<ChallengeTimeline> {
  const cfg = await getSetting('price_challenge');
  return fastTrack ? cfg.fastTrack : cfg.standard;
}

/** Schedules every reminder, the admin escalation and the final auto-action. */
export async function scheduleChallenge(challengeId: string, fastTrack: boolean) {
  const t = await timelineFor(fastTrack);
  for (const s of challengeSchedule(t)) {
    await jobs().scheduleChallengeStep({ challengeId, step: s.step, n: s.step === 'reminder' ? s.n : undefined }, s.atHours * HOUR);
  }
}

/**
 * Applies the customer's evidenced prices to the challenged part lines. The
 * technician's disclosed markup % is kept and recalculated on the new base cost.
 */
export async function applyChallengedPrices(db: pg.PoolClient, challengeId: string) {
  const lines = (await db.query('SELECT * FROM price_challenge_lines WHERE challenge_id = $1', [challengeId])).rows;
  let quoteId: string | null = null;
  for (const l of lines) {
    const item = await one('SELECT * FROM quote_items WHERE id = $1', [l.quote_item_id], db);
    if (!item) continue;
    quoteId = item.quote_id;
    const p = priceLine({ kind: 'material', description: item.description, quantity: Number(item.quantity), unitPriceMinor: Number(l.proposed_unit_price_minor), markupBps: item.markup_bps });
    await db.query('UPDATE quote_items SET unit_price_minor = $2, base_minor = $3, markup_minor = $4, total_minor = $5 WHERE id = $1', [
      item.id,
      Number(l.proposed_unit_price_minor),
      p.baseMinor,
      p.markupMinor,
      p.totalMinor,
    ]);
  }
  if (quoteId) await refreshQuoteTotals(db, quoteId);
}

async function notifyAdmins(title: string, body: string, data: Record<string, string>) {
  const admins = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND is_active`);
  await Promise.all(admins.map((a) => jobs().notify(a.id, { title, body, data })));
}

/** Runs one scheduled step of a challenge's timeline; no-op once the challenge is resolved. */
export async function processChallengeStep({ challengeId, step }: ChallengeStepData): Promise<string> {
  const c = await one(
    `SELECT pc.*, j.ref AS job_ref, j.title AS job_title, j.category_id, u.email AS tech_email, u.phone_e164 AS tech_phone, u.full_name AS tech_name,
            ts.labor_only_policy
       FROM price_challenges pc JOIN jobs j ON j.id = pc.job_id JOIN users u ON u.id = pc.technician_id
       LEFT JOIN technician_services ts ON ts.technician_id = pc.technician_id AND ts.category_id = j.category_id
      WHERE pc.id = $1`,
    [challengeId],
  );
  if (!c || c.status !== 'pending') return 'skipped';
  const urgent = c.fast_track ? 'URGENT: ' : '';
  const data = { jobId: c.job_id, type: 'price_challenge', challengeId, urgent: String(c.fast_track) };

  switch (step) {
    case 'reminder': {
      await query('UPDATE price_challenges SET reminders_sent = reminders_sent + 1 WHERE id = $1', [challengeId]);
      await jobs().notify(c.technician_id, {
        title: `${urgent}Price challenge waiting`,
        body: `The customer challenged your parts prices on #${c.job_ref}. Match, explain or hold firm.`,
        data,
      });
      return 'reminded';
    }
    case 'escalate': {
      await query('UPDATE price_challenges SET escalated_at = now() WHERE id = $1', [challengeId]);
      await audit(c.job_id, null, 'price_challenge.escalated', { challengeId, fastTrack: c.fast_track, remindersSent: c.reminders_sent });
      await notifyAdmins(`${urgent}Price challenge escalated`, `No response on #${c.job_ref} from ${c.tech_name}`, data);
      const t = await timelineFor(c.fast_track);
      const text = `${urgent}A customer's price challenge on job #${c.job_ref} ("${c.job_title}") has had no response and is now with our team. If you don't respond within ${t.finalActionHours - t.adminEscalationHours} hours, it will be resolved automatically.`;
      try {
        if (c.tech_email) await email().send({ to: c.tech_email, subject: `${urgent}Action needed: price challenge on #${c.job_ref}`, text });
        if (c.tech_phone) await whatsapp().sendTemplate(c.tech_phone, 'price_challenge_escalation', [c.job_ref, String(t.finalActionHours - t.adminEscalationHours)]);
      } catch (err) {
        logger.error({ err, challengeId }, 'price challenge escalation message failed');
      }
      return 'escalated';
    }
    case 'final': {
      const { timeoutAction } = await getSetting('price_challenge');
      const outcome = await tx(async (db) => {
        const locked = await one(`SELECT status FROM price_challenges WHERE id = $1 FOR UPDATE`, [challengeId], db);
        if (locked?.status !== 'pending') return 'skipped';
        await db.query('SELECT 1 FROM quotes WHERE id = $1 FOR UPDATE', [c.quote_id]);
        if (timeoutAction === 'auto_approve') {
          await applyChallengedPrices(db, challengeId);
          await db.query(`UPDATE price_challenges SET status = 'auto_approved', resolved_at = now() WHERE id = $1`, [challengeId]);
        } else {
          await db.query(`UPDATE price_challenges SET status = 'auto_cancelled', resolved_at = now() WHERE id = $1`, [challengeId]);
        }
        await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1 AND status = 'countered'`, [c.quote_id]);
        await audit(c.job_id, null, `price_challenge.${timeoutAction === 'auto_approve' ? 'auto_approved' : 'auto_cancelled'}`, { challengeId, timeoutAction }, db);
        return timeoutAction;
      });
      if (outcome === 'skipped') return 'skipped';
      if (outcome === 'auto_approve') {
        await jobs().notify(c.customer_id, { title: 'Price challenge approved', body: `The technician didn't respond, so your evidenced prices now apply to #${c.job_ref}.`, data });
        await jobs().notify(c.technician_id, { title: 'Price challenge auto-approved', body: `No response on #${c.job_ref}: the customer's evidenced prices were applied.`, data });
      } else {
        const laborOnly = c.labor_only_policy === 'accept';
        await jobs().notify(c.customer_id, {
          title: 'Price challenge closed',
          body: laborOnly
            ? `The technician didn't respond on #${c.job_ref}. You can buy the parts yourself and send a labor-only request instead.`
            : `The technician didn't respond on #${c.job_ref}. You can approve their quote or choose another technician.`,
          data: { ...data, redirect: laborOnly ? 'labor_only' : 'none' },
        });
      }
      return outcome;
    }
  }
}
