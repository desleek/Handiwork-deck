import AsyncStorage from '@react-native-async-storage/async-storage';
import { type FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { type Auth, getAuth, getReactNativePersistence, initializeAuth } from 'firebase/auth';
import { type Firestore, getFirestore } from 'firebase/firestore';
import { FIREBASE_CONFIG, FIREBASE_ENABLED } from './config';

let app: FirebaseApp | undefined;
let auth: Auth | undefined;

export function firebaseApp(): FirebaseApp {
  if (!FIREBASE_ENABLED) throw new Error('Firebase is not configured');
  app ??= getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  return app;
}

export function firebaseAuth(): Auth {
  if (auth) return auth;
  try {
    auth = initializeAuth(firebaseApp(), { persistence: getReactNativePersistence(AsyncStorage) });
  } catch {
    auth = getAuth(firebaseApp()); // already initialised (fast refresh)
  }
  return auth;
}

export const firestore = (): Firestore => getFirestore(firebaseApp());
