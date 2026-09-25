import type { UserRole } from '@handiwork/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, setTokenGetter } from './api';
import { FIREBASE_ENABLED } from './config';
import { firebaseAuth } from './firebase';

export interface AppUser {
  id: string;
  role: UserRole;
  full_name: string;
  email: string | null;
  phone_e164: string | null;
  customer_type: string | null;
  company_name: string | null;
}

interface AuthState {
  /** Signed in with Firebase (or dev identity). */
  signedIn: boolean;
  /** Registered on the platform; null until onboarding completes. */
  user: AppUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  devSignIn: (uid: string, phone?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);
const DEV_KEY = 'handiwork.devIdentity';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const signedIn = Boolean(fbUser || devToken);

  useEffect(() => {
    setTokenGetter(async () => (fbUser ? fbUser.getIdToken() : devToken));
  }, [fbUser, devToken]);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api<{ user: AppUser }>('/me');
      setUser(user);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) setUser(null);
      else throw e;
    }
  }, []);

  // Restore session.
  useEffect(() => {
    if (FIREBASE_ENABLED) {
      return onAuthStateChanged(firebaseAuth(), (u) => {
        setFbUser(u);
        if (!u) {
          setUser(null);
          setLoading(false);
        }
      });
    }
    AsyncStorage.getItem(DEV_KEY)
      .then((t) => (t ? setDevToken(t) : setLoading(false)))
      .catch(() => setLoading(false));
  }, []);

  // Load the platform profile whenever the identity changes.
  useEffect(() => {
    if (!signedIn) return;
    setLoading(true);
    refresh()
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [signedIn, fbUser, devToken, refresh]);

  const devSignIn = useCallback(async (uid: string, phone?: string) => {
    const token = `dev:${uid}${phone ? `:${phone}` : ''}`;
    await AsyncStorage.setItem(DEV_KEY, token);
    setDevToken(token);
  }, []);

  const signOut = useCallback(async () => {
    if (FIREBASE_ENABLED) await fbSignOut(firebaseAuth());
    await AsyncStorage.removeItem(DEV_KEY);
    setDevToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ signedIn, user, loading, refresh, devSignIn, signOut }),
    [signedIn, user, loading, refresh, devSignIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
