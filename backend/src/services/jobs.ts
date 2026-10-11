import { one, query, type Db } from '../db/pool.ts';
import { ACTION_REQUIRED, type Party } from '../domain/penalties.ts';
import { CONTACT_RELEASE_STATUSES } from '../domain/privacy.ts';
import { conflict, forbidden, notFound } from '../lib/http.ts';

export interface JobRow {
  id: string;
  short_code: string;
  kind: 'standard' | 'construction';
  booking_type: 'instant' | 'request';
  customer_id: string;
  technician_id: string;
  category_id: string;
  status: string;
  description: string;
  address: string;
  lat: number | null;
  lng: number | null;
  scheduled_for: Date | null;
  is_fast_track: boolean;
  currency: string;
  action_required_from: Party;
  action_required_reason: string | null;
  action_required_since: Date;
  contacts_released_at: Date | null;
  created_at: Date;
}

/** Allowed status transitions. Anything else is rejected with 409. */
const TRANSITIONS: Record<string, string[]> = {
  requested: ['accepted', 'declined', 'cancelled', 'incomplete'],
  accepted: ['quoted', 'cancelled', 'incomplete'],
  quoted: ['negotiating', 'approved', 'quoted', 'cancelled', 'incomplete'],
  negotiating: ['quoted', 'approved', 'negotiating', 'cancelled', 'incomplete'],
  approved: ['funded', 'cancelled', 'incomplete', 'negotiating'],
  funded: ['en_route', 'in_progress', 'cancelled', 'disputed', 'incomplete'],
  en_route: ['in_progress', 'cancelled', 'disputed', 'incomplete'],
  in_progress: ['awaiting_confirmation', 'disputed', 'incomplete'],
  awaiting_confirmation: ['completed', 'disputed', 'in_progress', 'incomplete'],
  disputed: ['completed', 'cancelled', 'in_progress'],
};

/** Construction & plant erection (Section 17): consultation → BOQ → milestones. */
const CONSTRUCTION_TRANSITIONS: Record<string, string[]> = {
  requested: ['accepted', 'declined', 'cancelled', 'incomplete'], // consultation requested → fee quoted
  accepted: ['funded', 'cancelled', 'incomplete'], //                fee quoted → fee paid
  funded: ['quoted', 'cancelled', 'disputed', 'incomplete'], //       visit → BOQ submitted
  quoted: ['negotiating', 'approved', 'cancelled', 'incomplete'], //  BOQ under customer review
  negotiating: ['quoted', 'cancelled', 'incomplete'], //              revision requested
  approved: ['in_progress', 'cancelled', 'incomplete'], //            BOQ + milestones agreed
  in_progress: ['completed', 'disputed', 'incomplete'], //            milestones running
  disputed: ['in_progress', 'completed', 'cancelled', 'funded'],
};

export async function getJob(id: string, db?: Db, forUpdate = false): Promise<JobRow> {
  const job = await one<JobRow>(`SELECT * FROM jobs WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id], db);
  if (!job) throw notFound('Job');
  return job;
}

export function assertParticipant(job: JobRow, userId: string, role: string) {
  if (role === 'admin') return;
  if (job.customer_id !== userId && job.technician_id !== userId) throw notFound('Job');
}

/** Standard-job endpoints refuse construction projects, which have their own flow (Section 17). */
export function assertStandard(job: JobRow) {
  if (job.kind === 'construction') {
    throw conflict('USE_CONSTRUCTION_FLOW', 'This is a construction project — use the site consultation, BOQ and milestone steps');
  }
}

export function assertCustomer(job: JobRow, userId: string) {
  if (job.customer_id !== userId) throw forbidden('NOT_CUSTOMER', 'Only the customer on this job can do that');
}

export function assertTechnician(job: JobRow, userId: string) {
  if (job.technician_id !== userId) throw forbidden('NOT_TECHNICIAN', 'Only the technician on this job can do that');
}

export async function logJobEvent(db: Db, jobId: string, actorId: string | null, type: string, payload: object = {}) {
  await query('INSERT INTO job_events (job_id, actor_id, type, payload) VALUES ($1, $2, $3, $4)', [
    jobId,
    actorId,
    type,
    JSON.stringify(payload),
  ], db);
}

/**
 * Move a job to a new status, keeping the Section 18 "action required from" state current
 * and releasing contact details at the right moment (Section 8).
 */
export async function transition(
  db: Db,
  job: JobRow,
  to: string,
  actorId: string | null,
  opts: { actionFrom?: Party; actionReason?: string; event?: object } = {},
) {
  const allowed = (job.kind === 'construction' ? CONSTRUCTION_TRANSITIONS : TRANSITIONS)[job.status] ?? [];
  if (!allowed.includes(to)) {
    throw conflict('INVALID_TRANSITION', `Cannot move a ${job.status} job to ${to}`);
  }
  const action = opts.actionFrom
    ? { party: opts.actionFrom, reason: opts.actionReason ?? '' }
    : ACTION_REQUIRED[to] ?? { party: 'none' as Party, reason: '' };
  const releaseContacts = CONTACT_RELEASE_STATUSES.has(to) && !job.contacts_released_at;
  await query(
    `UPDATE jobs SET status = $2::job_status, action_required_from = $3, action_required_reason = $4,
       action_required_since = now(), updated_at = now(),
       contacts_released_at = CASE WHEN $5 THEN now() ELSE contacts_released_at END,
       completed_at = CASE WHEN $2::job_status = 'completed' THEN now() ELSE completed_at END,
       cancelled_at = CASE WHEN $2::job_status IN ('cancelled', 'declined') THEN now() ELSE cancelled_at END
     WHERE id = $1`,
    [job.id, to, action.party, action.reason, releaseContacts],
    db,
  );
  await logJobEvent(db, job.id, actorId, `status.${to}`, { from: job.status, ...(opts.event ?? {}) });
  job.status = to;
  job.action_required_from = action.party;
}

/** Update only who must act (sub-flows inside 'negotiating'). */
export async function setActionRequired(db: Db, jobId: string, party: Party, reason: string) {
  await query(
    `UPDATE jobs SET action_required_from = $2, action_required_reason = $3, action_required_since = now(), updated_at = now()
     WHERE id = $1`,
    [jobId, party, reason],
    db,
  );
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newShortCode(): string {
  let s = 'HW';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
