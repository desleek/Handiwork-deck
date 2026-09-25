import type { Queryable } from '../../db/pool';
import { one } from '../../db/pool';

/** Statuses in which a customer has approved (hired) the technician. */
const APPROVED_STATUSES = new Set(['assigned', 'en_route', 'in_progress', 'completed', 'paid', 'disputed']);

/**
 * "Approved" = this technician's quote was accepted for the job. Before that,
 * contact details are masked in every message between the parties.
 */
export function isApproved(job: { status: string; technician_id: string | null }, technicianId: string): boolean {
  return job.technician_id === technicianId && APPROVED_STATUSES.has(job.status);
}

export async function ensureConversation(db: Queryable, jobId: string, customerId: string, technicianId: string) {
  return one<{ id: string; is_open: boolean }>(
    `INSERT INTO conversations (job_id, customer_id, technician_id) VALUES ($1, $2, $3)
     ON CONFLICT (job_id, technician_id) DO UPDATE SET job_id = EXCLUDED.job_id
     RETURNING id, is_open`,
    [jobId, customerId, technicianId],
    db,
  );
}
