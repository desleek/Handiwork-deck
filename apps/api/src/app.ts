import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { advertisingModule } from './modules/advertising/index';
import { adminRouter } from './routes/admin';
import { adminPricingRouter } from './routes/adminPricing';
import { adminQualityRouter } from './routes/adminQuality';
import { adminTaxonomyRouter } from './routes/adminTaxonomy';
import { categoriesRouter } from './routes/categories';
import { chatRouter } from './routes/chat';
import { discoverRouter } from './routes/discover';
import { quotesRouter } from './routes/quotes';
import { healthRouter } from './routes/health';
import { jobRequestsRouter } from './routes/jobRequests';
import { priceChallengesRouter } from './routes/priceChallenges';
import { jobsRouter } from './routes/jobs';
import { technicianBusinessRouter } from './routes/technicianBusiness';
import { trackingRouter } from './routes/tracking';
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
    technicianBusinessRouter,
    techniciansRouter,
    jobsRouter,
    jobRequestsRouter,
    quotesRouter,
    priceChallengesRouter,
    chatRouter,
    trackingRouter,
    paymentsRouter,
    uploadsRouter,
    adminRouter,
    adminTaxonomyRouter,
    adminPricingRouter,
    adminQualityRouter,
  );

  // Section 12: bolt-on modules mount last. Core routes never import them, and a
  // module that fails to load is skipped rather than taking the app down.
  try {
    app.use('/v1', advertisingModule());
  } catch (err) {
    logger.error({ err }, 'advertising module failed to load; continuing without it');
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
