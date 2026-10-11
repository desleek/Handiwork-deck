import { Worker } from 'bullmq';
import { logger } from './lib/logger.ts';
import { runEscalationStep } from './queue/escalations.ts';
import {
  boostLifecycle,
  expireRestrictions,
  processStandardWithdrawals,
  recalcMultipliers,
  scanIncompleteTransactions,
  sendPushAlert,
} from './queue/maintenance.ts';
import { connection, QUEUE, registerRepeatables } from './queue/queues.ts';

const workers = [
  new Worker(QUEUE.escalations, async (job) => runEscalationStep(job.data.challengeId, job.data.step), { connection, concurrency: 10 }),
  new Worker(QUEUE.alerts, async (job) => sendPushAlert(job.data.alertId), { connection, concurrency: 2 }),
  new Worker(
    QUEUE.maintenance,
    async (job) => {
      switch (job.name) {
        case 'incomplete-scan':
          return scanIncompleteTransactions();
        case 'boost-lifecycle':
          return boostLifecycle();
        case 'multiplier-recalc':
          return recalcMultipliers();
        case 'restriction-expiry':
          return expireRestrictions();
        case 'standard-withdrawals':
          return processStandardWithdrawals();
      }
    },
    { connection, concurrency: 1 },
  ),
];

for (const w of workers) {
  w.on('failed', (job, err) => logger.error({ queue: w.name, job: job?.name, err }, 'job failed'));
}

await registerRepeatables();
logger.info('worker started');

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
