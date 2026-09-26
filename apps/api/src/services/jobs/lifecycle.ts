import { canTransition, type JobStatus, type UserRole } from '@handiwork/shared';
import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { env } from '../../config/env';
import { one, pool, tx } from '../../db/pool';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { jobs, minutes } from '../../queues/index';
import { setLiveJobAccess } from '../liveLocation';

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function newJobRef(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `HW-${s}`;
}

export interface JobRecord {
  id: string;
  ref: string;
  customer_id: string;
  technician_id: string | null;
  status: JobStatus;
  scheduled_for: Date | null;
  currency: string;
}

export interface Actor {
  id: string | null; // null = system
  role: UserRole | 'system';
}

/**
 * Moves a job along its lifecycle inside a transaction, enforcing the shared
 * state machine plus party checks (only *this* job's customer/technician may act),
 * and records history. Side effects run after commit.
 */
export async function transitionJob(
  jobId: string,
  to: JobStatus,
  actor: Actor,
  opts: { note?: string; db?: pg.PoolClient; extra?: (db: pg.PoolClient, job: JobRecord) => Promise<void> } = {},
): Promise<JobRecord> {
  const run = async (db: pg.PoolClient) => {
    const job = await one<JobRecord>('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId], db);
    if (!job) throw notFound('Job');
    if (actor.role === 'customer' && job.customer_id !== actor.id) throw forbidden('Not your job');
    if (actor.role === 'technician' && job.technician_id !== actor.id) throw forbidden('Not assigned to this job');
    if (!canTransition(job.status, to, actor.role)) {
      throw conflict(`Cannot move job from ${job.status} to ${to} as ${actor.role}`);
    }
    await opts.extra?.(db, job);
    const updated = await one<JobRecord>('UPDATE jobs SET status = $2 WHERE id = $1 RETURNING *', [jobId, to], db);
    await db.query(
      'INSERT INTO job_status_history (job_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)',
      [jobId, job.status, to, actor.id, opts.note ?? null],
    );
    return updated!;
  };
  const job = opts.db ? await run(opts.db) : await tx(run);
  if (!opts.db) await afterTransition(job);
  return job;
}

/** Notifications, escalation timers and live-location access for the new state. */
export async function afterTransition(job: JobRecord): Promise<void> {
  const notify = (userId: string | null, title: string, body: string) =>
    userId ? jobs().notify(userId, { title, body, data: { jobId: job.id, type: `job.${job.status}` } }) : Promise.resolve();

  const uids = await one<{ customer_uid: string; technician_uid: string | null }>(
    `SELECT cu.firebase_uid AS customer_uid, te.firebase_uid AS technician_uid
       FROM jobs j JOIN users cu ON cu.id = j.customer_id LEFT JOIN users te ON te.id = j.technician_id
      WHERE j.id = $1`,
    [job.id],
  );
  const liveAccess = (active: boolean) =>
    uids?.technician_uid
      ? setLiveJobAccess(job.id, { customerUid: uids.customer_uid, technicianUid: uids.technician_uid, active })
      : Promise.resolve();

  // Section 9: en-route positions are only kept while en route.
  if (job.status !== 'en_route') await pool.query('DELETE FROM job_tracking WHERE job_id = $1', [job.id]);

  switch (job.status) {
    case 'assigned': {
      if (job.technician_id) {
        await jobs().notify(job.technician_id, {
          title: 'You got the job!',
          body: `Your quote for #${job.ref} was accepted.`,
          data: { jobId: job.id, jobRef: job.ref, type: 'job.assigned' },
          whatsapp: true,
        });
      }
      const startAt = job.scheduled_for ? new Date(job.scheduled_for).getTime() : Date.now();
      const delay = Math.max(startAt - Date.now(), 0) + minutes(env.ESCALATE_NO_SHOW_AFTER_MIN);
      await jobs().scheduleEscalation({ kind: 'no_show', jobId: job.id }, delay);
      break;
    }
    case 'en_route':
      await liveAccess(true);
      await notify(job.customer_id, 'Technician on the way', `Track your technician live for #${job.ref}.`);
      break;
    case 'in_progress':
      await liveAccess(false);
      await notify(job.customer_id, 'Work started', `Your technician has started work on #${job.ref}.`);
      break;
    case 'completed':
      await liveAccess(false);
      await notify(job.customer_id, 'Job completed', `Please review and pay for #${job.ref}.`);
      break;
    case 'paid':
      await notify(job.technician_id, 'Payment received', `The customer has paid for #${job.ref}.`);
      break;
    case 'cancelled':
      await liveAccess(false);
      await notify(job.customer_id, 'Job cancelled', `#${job.ref} was cancelled.`);
      await notify(job.technician_id, 'Job cancelled', `#${job.ref} was cancelled.`);
      break;
    case 'disputed':
      await notify(job.customer_id, 'Dispute opened', `Our support team will review #${job.ref}.`);
      await notify(job.technician_id, 'Dispute opened', `Our support team will review #${job.ref}.`);
      break;
  }
}
