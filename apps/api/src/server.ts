import { env } from './config/env';
import { createApp } from './app';
import { pool } from './db/pool';
import { logger } from './lib/logger';
import { jobs } from './queues/index';

const server = createApp().listen(env.PORT, () => logger.info(`HANDIWORK-DECK API listening on :${env.PORT}`));

async function shutdown() {
  logger.info('shutting down');
  server.close();
  await jobs().close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
