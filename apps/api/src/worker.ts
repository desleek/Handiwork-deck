import { Worker } from 'bullmq';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { processEscalation } from './queues/escalations';
import { Queue } from 'bullmq';
import { type ChallengeStepData, type EscalationJobData, jobs, type NotificationJobData, type PayoutJobData, QUEUE_NAMES, redisConnection } from './queues/index';
import { processChallengeStep } from './services/priceChallenges';
import { runEscrowAutoRelease } from './services/escrow';
import { runRateCycle } from './services/rateAdjustment';
import { processPayout } from './services/payouts';
import { pushToUser } from './services/notifications/push';

const connection = redisConnection();

const workers = [
  new Worker<EscalationJobData>(QUEUE_NAMES.escalations, (job) => processEscalation(job.data), { connection, concurrency: 5 }),
  new Worker<NotificationJobData>(QUEUE_NAMES.notifications, (job) => pushToUser(job.data.userId, job.data.message), {
    connection,
    concurrency: 20,
  }),
  new Worker<PayoutJobData>(QUEUE_NAMES.payouts, (job) => processPayout(job.data.payoutId), { connection, concurrency: 2 }),
  new Worker<ChallengeStepData>(QUEUE_NAMES.challenges, (job) => processChallengeStep(job.data), { connection, concurrency: 5 }),
  // Section 7a: hourly sweep recalculates technicians whose rate cycle (default 14 days) has elapsed.
  // Section 11: hourly sweep auto-releases escrow for completed jobs past the confirmation window.
  new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      if (job.name === 'rate-cycle') return runRateCycle();
      if (job.name === 'escrow-release') return runEscrowAutoRelease();
      return undefined;
    },
    { connection, concurrency: 1 },
  ),
];

const maintenance = new Queue(QUEUE_NAMES.maintenance, { connection });
await maintenance.upsertJobScheduler('rate-cycle', { every: 60 * 60 * 1000 }, { name: 'rate-cycle' });
await maintenance.upsertJobScheduler('escrow-release', { every: 60 * 60 * 1000 }, { name: 'escrow-release' });

for (const w of workers) {
  w.on('failed', (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, 'queue job failed'));
  w.on('completed', (job, result) => logger.debug({ queue: w.name, jobId: job.id, result }, 'queue job completed'));
}
logger.info('worker started');

async function shutdown() {
  logger.info('worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await maintenance.close();
  await jobs().close();
  await pool.end();
  connection.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
