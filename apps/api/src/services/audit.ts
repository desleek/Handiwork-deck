import type { Queryable } from '../db/pool';
import { pool } from '../db/pool';

/**
 * Job audit trail: quotes, revisions, counters, Demand Notices (requests,
 * evidence, decisions), receipts, booking-request responses. Append-only.
 */
export async function audit(jobId: string, actorId: string | null, action: string, details: Record<string, unknown> = {}, db: Queryable = pool) {
  await db.query('INSERT INTO job_audit_log (job_id, actor_id, action, details) VALUES ($1, $2, $3, $4)', [jobId, actorId, action, JSON.stringify(details)]);
}
