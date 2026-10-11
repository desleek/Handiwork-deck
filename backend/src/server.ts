import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { pool } from './db/pool.ts';
import { logger } from './lib/logger.ts';

const server = createApp().listen(env.PORT, () => logger.info(`Handiwork-Deck API listening on :${env.PORT}`));

const shutdown = () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
