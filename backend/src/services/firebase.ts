import type { App } from 'firebase-admin/app';
import { env } from '../config/env.ts';

let appPromise: Promise<App | null> | null = null;

/** Lazily initialise firebase-admin. Returns null when credentials are absent (local dev). */
export function firebaseApp(): Promise<App | null> {
  appPromise ??= (async () => {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return null;
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    return (
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: env.FIREBASE_PRIVATE_KEY,
        }),
      })
    );
  })();
  return appPromise;
}
