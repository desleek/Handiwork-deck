import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.ts';
import { scheduleDelays } from '../domain/escalation.ts';
import type { EscalationTimeline } from '../domain/settings.ts';

export const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE = {
  escalations: 'escalations',
  alerts: 'push-alerts',
  maintenance: 'maintenance',
} as const;

export const escalationsQueue = new Queue(QUEUE.escalations, { connection });
export const alertsQueue = new Queue(QUEUE.alerts, { connection });
export const maintenanceQueue = new Queue(QUEUE.maintenance, { connection });

/**
 * Enqueue the whole Section 6c timeline for a price challenge as delayed jobs.
 * Job ids are deterministic so re-enqueueing is idempotent; every step re-checks the
 * challenge state when it fires and no-ops if the technician has already responded.
 */
export async function schedulePriceChallenge(challengeId: string, submittedAt: Date, timeline: EscalationTimeline, fastTrack: boolean) {
  const steps = scheduleDelays(timeline, submittedAt, new Date());
  await escalationsQueue.addBulk(
    steps.map(({ step, delayMs }) => ({
      name: step.type,
      data: { challengeId, step, fastTrack },
      opts: {
        jobId: `pc:${challengeId}:${step.type}:${step.hour}`,
        delay: delayMs,
        priority: fastTrack ? 1 : 5,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    })),
  );
}

export async function enqueuePushAlert(alertId: string) {
  await alertsQueue.add('send', { alertId }, { jobId: `alert:${alertId}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
}

/** Repeatable maintenance jobs — registered once by the worker process. */
export async function registerRepeatables() {
  await maintenanceQueue.upsertJobScheduler('incomplete-scan', { pattern: '0 * * * *' }, { name: 'incomplete-scan' });
  await maintenanceQueue.upsertJobScheduler('boost-lifecycle', { every: 60_000 }, { name: 'boost-lifecycle' });
  await maintenanceQueue.upsertJobScheduler('multiplier-recalc', { pattern: '30 2 * * *' }, { name: 'multiplier-recalc' });
  await maintenanceQueue.upsertJobScheduler('restriction-expiry', { pattern: '*/15 * * * *' }, { name: 'restriction-expiry' });
  await maintenanceQueue.upsertJobScheduler('standard-withdrawals', { pattern: '0 9 * * 1-5' }, { name: 'standard-withdrawals' });
}
