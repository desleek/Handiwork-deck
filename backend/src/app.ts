import cors from 'cors';
import type { Request, Response } from 'express';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { pool } from './db/pool.ts';
import { errorHandler } from './lib/http.ts';
import { logger } from './lib/logger.ts';
import { admin } from './routes/admin.ts';
import { advertiser } from './routes/advertiser.ts';
import { catalog } from './routes/catalog.ts';
import { comms } from './routes/comms.ts';
import { jobs } from './routes/jobs.ts';
import { me } from './routes/me.ts';
import { quotes } from './routes/quotes.ts';
import { technician } from './routes/technician.ts';
import { wallet } from './routes/wallet.ts';
import { payments, webhooks } from './routes/webhooks.ts';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req: Request) => req.url === '/health' } }));

  // Webhooks need the raw body for signature checks — mount before the JSON parser.
  app.use('/webhooks', webhooks);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req: Request, res: Response) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/me', me);
  app.use('/', catalog); // /categories, /technicians, /sellers, /deals
  app.use('/technician', technician);
  app.use('/jobs', jobs);
  app.use('/jobs/:id', quotes); // quotes, labor-only, price challenges, labor negotiation
  app.use('/jobs/:id', comms); // chat & ratings
  app.use('/wallet', wallet);
  app.use('/payments', payments);
  app.use('/admin', admin);
  app.use('/advertiser', advertiser); // ads bolt-on (Section 12)

  app.use((_req: Request, res: Response) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
