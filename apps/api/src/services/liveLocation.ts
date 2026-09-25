import { getFirestore } from 'firebase-admin/firestore';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { firebaseApp } from './firebase';

/**
 * Live technician location is streamed device-to-device through Firestore, not
 * through this API. The API only maintains `liveJobs/{jobId}` — who may write
 * (the assigned technician) and read (the customer) — which `firestore.rules`
 * enforces. The technician app writes `liveJobs/{jobId}/positions/latest`.
 */
export async function setLiveJobAccess(
  jobId: string,
  access: { customerUid: string; technicianUid: string; active: boolean },
): Promise<void> {
  if (!env.FIREBASE_PROJECT_ID) {
    logger.debug({ jobId, access }, 'live location (dry-run)');
    return;
  }
  const db = getFirestore(firebaseApp());
  await db.doc(`liveJobs/${jobId}`).set({ ...access, updatedAt: new Date() }, { merge: true });
  // Don't retain the technician's last position once the job no longer needs it.
  if (!access.active) await db.doc(`liveJobs/${jobId}/positions/latest`).delete();
}
