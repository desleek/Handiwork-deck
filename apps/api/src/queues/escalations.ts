import { env } from '../config/env';
import { one, query, tx } from '../db/pool';
import { logger } from '../lib/logger';
import { findMatchingTechnicians } from '../services/matching';
import { type EscalationJobData, jobs, minutes } from './index';

interface JobRow {
  id: string;
  ref: string;
  title: string;
  status: string;
  customer_id: string;
  technician_id: string | null;
  category_id: number;
  lat: number;
  lng: number;
  match_radius_km: number;
  escalation_level: number;
  quote_count: number;
}

async function loadJob(jobId: string) {
  return one<JobRow>(
    `SELECT j.*, (SELECT count(*) FROM quotes q WHERE q.job_id = j.id AND q.status = 'pending')::int AS quote_count
       FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
}

async function notifyAdmins(title: string, body: string, data: Record<string, string>) {
  const admins = await query<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' AND is_active`);
  await Promise.all(admins.map((a) => jobs().notify(a.id, { title, body, data })));
}

/**
 * Escalation ladder. Each step re-checks the job's current state first, so a job
 * that progressed in the meantime makes the escalation a no-op.
 *
 *  - no_quote_widen: open with no quotes after N min → widen search radius, ping new technicians
 *  - no_quote_admin: still no quotes after M min → alert ops/admins and reassure the customer
 *  - no_show: assigned but technician not en route by scheduled time + K min → alert admins & customer
 */
export async function processEscalation({ kind, jobId }: EscalationJobData): Promise<string> {
  const job = await loadJob(jobId);
  if (!job) return 'job_missing';

  switch (kind) {
    case 'no_quote_widen': {
      if (job.status !== 'open' || job.quote_count > 0) return 'skipped';
      const oldRadius = Number(job.match_radius_km);
      const newRadius = oldRadius * env.MATCH_WIDEN_RADIUS_FACTOR;
      const before = new Set((await findMatchingTechnicians(job, oldRadius)).map((t) => t.user_id));
      const after = await findMatchingTechnicians(job, newRadius);
      await tx(async (db) => {
        await db.query('UPDATE jobs SET match_radius_km = $2, escalation_level = GREATEST(escalation_level, 1) WHERE id = $1', [
          jobId,
          newRadius,
        ]);
        await db.query(`INSERT INTO escalations (job_id, kind, level) VALUES ($1, $2, 1)`, [jobId, kind]);
      });
      const fresh = after.filter((t) => !before.has(t.user_id));
      await Promise.all(
        fresh.map((t) =>
          jobs().notify(t.user_id, {
            title: 'New job near you',
            body: `${job.title} — ${t.distance_km.toFixed(1)} km away`,
            data: { jobId, type: 'job.new' },
          }),
        ),
      );
      const remaining = env.ESCALATE_NO_QUOTE_ADMIN_AFTER_MIN - env.ESCALATE_NO_QUOTE_WIDEN_AFTER_MIN;
      await jobs().scheduleEscalation({ kind: 'no_quote_admin', jobId }, minutes(Math.max(remaining, 1)));
      logger.info({ jobId, newRadius, notified: fresh.length }, 'escalation: widened search radius');
      return 'widened';
    }

    case 'no_quote_admin': {
      if (job.status !== 'open' || job.quote_count > 0) return 'skipped';
      await tx(async (db) => {
        await db.query('UPDATE jobs SET escalation_level = GREATEST(escalation_level, 2) WHERE id = $1', [jobId]);
        await db.query(`INSERT INTO escalations (job_id, kind, level) VALUES ($1, $2, 2)`, [jobId, kind]);
      });
      await notifyAdmins('Job needs attention', `#${job.ref} "${job.title}" has no quotes yet`, { jobId, type: 'escalation' });
      await jobs().notify(job.customer_id, {
        title: "We're on it",
        body: 'Our team is personally finding a technician for your job.',
        data: { jobId, type: 'job.escalated' },
      });
      return 'admin_alerted';
    }

    case 'no_show': {
      if (job.status !== 'assigned') return 'skipped';
      await tx(async (db) => {
        await db.query('UPDATE jobs SET escalation_level = GREATEST(escalation_level, 2) WHERE id = $1', [jobId]);
        await db.query(`INSERT INTO escalations (job_id, kind, level) VALUES ($1, $2, 2)`, [jobId, kind]);
      });
      await notifyAdmins('Possible no-show', `Technician has not started #${job.ref}`, { jobId, type: 'escalation' });
      await jobs().notify(job.customer_id, {
        title: 'Your technician is running late',
        body: "We've alerted our support team and will update you shortly.",
        data: { jobId, type: 'job.escalated' },
      });
      if (job.technician_id) {
        await jobs().notify(job.technician_id, {
          title: 'Are you on your way?',
          body: `Tap "On my way" for job #${job.ref} or contact support.`,
          data: { jobId, type: 'job.reminder' },
        });
      }
      return 'admin_alerted';
    }
  }
}
