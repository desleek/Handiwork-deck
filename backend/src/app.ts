import cors from 'cors';
import type { Request, Response } from 'express';
import express from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.ts';
import { pool } from './db/pool.ts';
import { errorHandler } from './lib/http.ts';
import { logger } from './lib/logger.ts';
import { admin } from './routes/admin.ts';
import { advertiser } from './routes/advertiser.ts';
import { catalog } from './routes/catalog.ts';
import { comms } from './routes/comms.ts';
import { construction } from './routes/construction.ts';
import { seller, supplies } from './routes/supplies.ts';
import { jobs } from './routes/jobs.ts';
import { me } from './routes/me.ts';
import { quotes } from './routes/quotes.ts';
import { technician } from './routes/technician.ts';
import { wallet } from './routes/wallet.ts';
import { payments, webhooks } from './routes/webhooks.ts';

const PANEL_DIR = join(import.meta.dirname, '..', '..', 'admin-panel');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  // Admin web panel (static, no build step). Mounted before the global headers so it can allow
  // Google's scripts for Firebase phone sign-in; everything else stays same-origin.
  app.get('/admin-panel/config.js', (_req: Request, res: Response) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').send(
      `window.HW_CONFIG = ${JSON.stringify({
        authMode: env.AUTH_MODE,
        firebase: { apiKey: env.FIREBASE_WEB_API_KEY ?? null, authDomain: env.FIREBASE_AUTH_DOMAIN ?? null, projectId: env.FIREBASE_PROJECT_ID ?? null },
      })};`,
    );
  });
  app.use(
    '/admin-panel',
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'", 'https://www.gstatic.com', 'https://www.google.com', 'https://apis.google.com'],
          'connect-src': ["'self'", 'https://*.googleapis.com'],
          'frame-src': ['https://www.google.com', 'https://*.firebaseapp.com'],
          'img-src': ["'self'", 'data:', 'https:'],
          // Lets the panel be opened over plain http on a LAN address during development.
          'upgrade-insecure-requests': env.NODE_ENV === 'production' ? [] : null,
        },
      },
    }),
    express.static(PANEL_DIR, { index: 'index.html', maxAge: '5m' }),
  );

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
  app.use('/jobs/:id/construction', construction); // Section 17
  app.use('/wallet', wallet);
  app.use('/payments', payments);
  app.use('/admin', admin);
  app.use('/advertiser', advertiser); // ads bolt-on (Section 12)
  app.use('/supplies', supplies); // Section 13 (behind the supplies feature flag)
  app.use('/seller', seller); //     storefront management for sellers

  app.use((_req: Request, res: Response) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}
