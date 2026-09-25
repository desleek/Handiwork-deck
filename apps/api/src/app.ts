import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { adminRouter } from './routes/admin';
import { adminTaxonomyRouter } from './routes/adminTaxonomy';
import { categoriesRouter } from './routes/categories';
import { chatRouter } from './routes/chat';
import { discoverRouter } from './routes/discover';
import { quotesRouter } from './routes/quotes';
import { adsRouter } from './routes/ads';
import { healthRouter } from './routes/health';
import { jobsRouter } from './routes/jobs';
import { paymentsRouter, paymentWebhookRouter } from './routes/payments';
import { techniciansRouter } from './routes/technicians';
import { uploadsRouter } from './routes/uploads';
import { usersRouter } from './routes/users';
import { whatsappWebhookRouter } from './routes/whatsapp';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors());
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  // Webhooks need the raw body for signature checks: mount before express.json().
  app.use('/v1', paymentWebhookRouter, whatsappWebhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/v1',
    usersRouter,
    categoriesRouter,
    discoverRouter,
    techniciansRouter,
    jobsRouter,
    quotesRouter,
    chatRouter,
    paymentsRouter,
    uploadsRouter,
    adsRouter,
    adminRouter,
    adminTaxonomyRouter,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
