import { query } from '../db/pool';

/**
 * Paid jobs the customer hasn't reviewed yet — any of these blocks new bookings.
 * Section 7: reviews only come from verified, completed, platform-paid bookings.
 */
export async function pendingReviewJobs(customerId: string) {
  return query<{ id: string; ref: string; title: string; technician_id: string }>(
    `SELECT j.id, j.ref, j.title, j.technician_id FROM jobs j
      WHERE j.customer_id = $1 AND j.status = 'paid' AND j.technician_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.job_id = j.id)
      ORDER BY j.updated_at`,
    [customerId],
  );
}
