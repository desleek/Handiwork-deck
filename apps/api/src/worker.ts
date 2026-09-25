import { Worker } from 'bullmq';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { processEscalation } from './queues/escalations';
import { type EscalationJobData, jobs, type NotificationJobData, QUEUE_NAMES, redisConnection } from './queues/index';
import { pushToUser } from './services/notifications/push';

const connection = redisConnection();

const workers = [
  new Worker<EscalationJobData>(QUEUE_NAMES.escalations, (job) => processEscalation(job.data), { connection, concurrency: 5 }),
  new Worker<NotificationJobData>(QUEUE_NAMES.notifications, (job) => pushToUser(job.data.userId, job.data.message), {
    connection,
    concurrency: 20,
  }),
];

for (const w of workers) {
  w.on('failed', (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, 'queue job failed'));
  w.on('completed', (job, result) => logger.debug({ queue: w.name, jobId: job.id, result }, 'queue job completed'));
}
logger.info('worker started');

async function shutdown() {
  logger.info('worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await jobs().close();
  await pool.end();
  connection.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
