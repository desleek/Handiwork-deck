import { type App, applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env';

let app: App | undefined;

export function firebaseApp(): App {
  if (app) return app;
  if (getApps().length) return (app = getApps()[0]!);
  const credential = env.FIREBASE_SERVICE_ACCOUNT_B64
    ? cert(JSON.parse(Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')))
    : applicationDefault();
  app = initializeApp({ credential, projectId: env.FIREBASE_PROJECT_ID });
  return app;
}

export const firebaseAuth = () => getAuth(firebaseApp());
export const firebaseMessaging = () => getMessaging(firebaseApp());
