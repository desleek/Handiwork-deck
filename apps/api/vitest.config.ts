import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      PAYMENT_DEFAULT_PROVIDER: 'mock',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://handiwork:handiwork@localhost:5432/handiwork_test',
      WHATSAPP_DISPLAY_NUMBER: '2349000000000',
    },
    // DB-backed tests share one database; run files serially.
    fileParallelism: false,
  },
});
