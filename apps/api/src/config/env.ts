import { z } from 'zod';

const minutes = (def: number) => z.coerce.number().int().positive().default(def);
const optional = z.string().optional().transform((v) => (v ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:4000'),
  DATABASE_URL: z.string().default('postgres://handiwork:handiwork@localhost:5432/handiwork'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  AUTH_MODE: z.enum(['firebase', 'dev']).default('firebase'),
  FIREBASE_PROJECT_ID: optional,
  FIREBASE_SERVICE_ACCOUNT_B64: optional,

  PAYMENT_DEFAULT_PROVIDER: z.enum(['stripe', 'paystack', 'flutterwave', 'mock']).default('mock'),
  PAYMENT_CURRENCY_ROUTES: z.string().default(''),
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  PAYSTACK_SECRET_KEY: optional,
  FLUTTERWAVE_SECRET_KEY: optional,
  FLUTTERWAVE_WEBHOOK_HASH: optional,

  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_ACCESS_TOKEN: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_VERIFY_TOKEN: optional,
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  WHATSAPP_DISPLAY_NUMBER: optional,

  EMAIL_PROVIDER: z.enum(['log', 'sendgrid']).default('log'),
  SENDGRID_API_KEY: optional,
  EMAIL_FROM: z.string().default('HANDIWORK-DECK <no-reply@handiwork-deck.app>'),

  STORAGE_DRIVER: z.enum(['s3', 'cloudinary']).default('s3'),
  AWS_REGION: z.string().default('eu-west-1'),
  S3_BUCKET: optional,
  CLOUDINARY_CLOUD_NAME: optional,
  CLOUDINARY_API_KEY: optional,
  CLOUDINARY_API_SECRET: optional,

  ESCALATE_NO_QUOTE_WIDEN_AFTER_MIN: minutes(15),
  ESCALATE_NO_QUOTE_ADMIN_AFTER_MIN: minutes(60),
  ESCALATE_NO_SHOW_AFTER_MIN: minutes(30),
  MATCH_WIDEN_RADIUS_FACTOR: z.coerce.number().positive().default(2),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production');
  }
  if (env.NODE_ENV === 'production' && env.PAYMENT_DEFAULT_PROVIDER === 'mock') {
    throw new Error('PAYMENT_DEFAULT_PROVIDER=mock is not allowed in production');
  }
  return env;
}

export const env = load();
