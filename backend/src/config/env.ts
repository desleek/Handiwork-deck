function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

const opt = (name: string) => process.env[name] || undefined;

export const env = {
  NODE_ENV: str('NODE_ENV', 'development'),
  PORT: Number(str('PORT', '4000')),
  DATABASE_URL: str('DATABASE_URL', 'postgres://handiwork:handiwork@localhost:5432/handiwork'),
  REDIS_URL: str('REDIS_URL', 'redis://localhost:6379'),
  PUBLIC_API_URL: str('PUBLIC_API_URL', 'http://localhost:4000'),

  AUTH_MODE: str('AUTH_MODE', 'firebase') as 'firebase' | 'dev',
  FIREBASE_PROJECT_ID: opt('FIREBASE_PROJECT_ID'),
  FIREBASE_CLIENT_EMAIL: opt('FIREBASE_CLIENT_EMAIL'),
  FIREBASE_PRIVATE_KEY: opt('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
  // Public web config for the admin panel's Firebase sign-in (safe to expose to browsers).
  FIREBASE_WEB_API_KEY: opt('FIREBASE_WEB_API_KEY'),
  FIREBASE_AUTH_DOMAIN: opt('FIREBASE_AUTH_DOMAIN'),

  PAYSTACK_SECRET_KEY: opt('PAYSTACK_SECRET_KEY'),
  FLUTTERWAVE_SECRET_KEY: opt('FLUTTERWAVE_SECRET_KEY'),
  FLUTTERWAVE_WEBHOOK_HASH: opt('FLUTTERWAVE_WEBHOOK_HASH'),
  STRIPE_SECRET_KEY: opt('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: opt('STRIPE_WEBHOOK_SECRET'),
  PAYMENTS_ENABLE_MOCK: str('PAYMENTS_ENABLE_MOCK', 'false') === 'true',

  WHATSAPP_PHONE_NUMBER_ID: opt('WHATSAPP_PHONE_NUMBER_ID'),
  WHATSAPP_ACCESS_TOKEN: opt('WHATSAPP_ACCESS_TOKEN'),
  WHATSAPP_VERIFY_TOKEN: str('WHATSAPP_VERIFY_TOKEN', 'change-me'),
  WHATSAPP_APP_SECRET: opt('WHATSAPP_APP_SECRET'),

  EMAIL_FROM: str('EMAIL_FROM', 'no-reply@handiworkdeck.com'),
  SMTP_URL: opt('SMTP_URL'),

  STORAGE_DRIVER: str('STORAGE_DRIVER', 'local') as 's3' | 'cloudinary' | 'local',
  AWS_REGION: str('AWS_REGION', 'eu-west-1'),
  S3_BUCKET: opt('S3_BUCKET'),
  CLOUDINARY_CLOUD_NAME: opt('CLOUDINARY_CLOUD_NAME'),
  CLOUDINARY_API_KEY: opt('CLOUDINARY_API_KEY'),
  CLOUDINARY_API_SECRET: opt('CLOUDINARY_API_SECRET'),
};

if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev') {
  throw new Error('AUTH_MODE=dev is not allowed in production');
}
