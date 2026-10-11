import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Auth: Firebase phone sign-in in production; a "dev" mode (EXPO_PUBLIC_AUTH_MODE=dev) that
 * sends an x-dev-user-id header so the app can run against a local API without a Firebase project.
 */
const AUTH_MODE: 'firebase' | 'dev' = Constants.expoConfig?.extra?.authMode === 'dev' ? 'dev' : 'firebase';
const DEV_KEY = 'hw.devUserId';

let devUserId: string | null = null;

async function firebaseAuth() {
  return import('@react-native-firebase/auth');
}

export async function getIdToken(): Promise<Record<string, string>> {
  if (AUTH_MODE === 'dev') return devUserId ? { 'x-dev-user-id': devUserId } : {};
  const { getAuth } = await firebaseAuth();
  const user = getAuth().currentUser;
  return user ? { Authorization: `Bearer ${await user.getIdToken()}` } : {};
}

export interface Me {
  id: string;
  role: 'customer' | 'technician' | 'advertiser' | 'admin';
  full_name: string;
  status: 'active' | 'restricted' | 'suspended' | 'deleted';
  completion_badge: boolean;
  restrictions: { id: string; tier: 1 | 2; restrictedFunctions: string[]; endsAt: string | null }[];
  pendingReviewJobIds: string[];
}

type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'needs_registration' }
  | { status: 'ready'; me: Me };

interface AuthApi {
  state: AuthState;
  mode: 'firebase' | 'dev';
  /** Firebase: sends an SMS code. Returns a function that confirms the code. */
  startPhoneSignIn(phoneE164: string): Promise<(code: string) => Promise<void>>;
  devSignIn(userId: string): Promise<void>;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const { api, ApiError } = await import('../api/client');
    try {
      const me = await api<Me>('/me');
      setState({ status: 'ready', me });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_REGISTERED') setState({ status: 'needs_registration' });
      else if (err instanceof ApiError && (err.status === 401 || err.code === 'UNAUTHENTICATED')) setState({ status: 'signed_out' });
      else if (err instanceof ApiError && err.code === 'NETWORK') {
        // Offline at launch: keep whatever we had; cached screens still render.
        setState((s) => (s.status === 'loading' ? { status: 'signed_out' } : s));
      } else throw err;
    }
  }, []);

  useEffect(() => {
    if (AUTH_MODE === 'dev') {
      SecureStore.getItemAsync(DEV_KEY).then((id) => {
        devUserId = id;
        if (id) refresh();
        else setState({ status: 'signed_out' });
      });
      return;
    }
    let unsub = () => {};
    firebaseAuth().then(({ getAuth, onAuthStateChanged }) => {
      unsub = onAuthStateChanged(getAuth(), (user) => {
        if (user) refresh();
        else setState({ status: 'signed_out' });
      });
    });
    return () => unsub();
  }, [refresh]);

  const api = useMemo<AuthApi>(
    () => ({
      state,
      mode: AUTH_MODE,
      async startPhoneSignIn(phoneE164) {
        const { getAuth, signInWithPhoneNumber } = await firebaseAuth();
        const confirmation = await signInWithPhoneNumber(getAuth(), phoneE164);
        return async (code: string) => {
          await confirmation.confirm(code);
        };
      },
      async devSignIn(userId) {
        devUserId = userId;
        await SecureStore.setItemAsync(DEV_KEY, userId);
        await refresh();
      },
      refresh,
      async signOut() {
        if (AUTH_MODE === 'dev') {
          devUserId = null;
          await SecureStore.deleteItemAsync(DEV_KEY);
        } else {
          const { getAuth, signOut } = await firebaseAuth();
          await signOut(getAuth());
        }
        setState({ status: 'signed_out' });
      },
    }),
    [state, refresh],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'ready') throw new Error('Not signed in');
  return state.me;
}
