import { Redirect } from 'expo-router';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { registerForPush } from '@/lib/push';

const HOME = {
  customer: '/(customer)',
  technician: '/(technician)',
  advertiser: '/(advertiser)',
  admin: '/(admin)',
} as const;

/** Routes the user to sign-in, onboarding, or their role's home. */
export default function Gate() {
  const { signedIn, user, loading } = useAuth();

  useEffect(() => {
    if (user) registerForPush().catch(() => {});
  }, [user]);

  if (loading) return <Loading />;
  if (!signedIn) return <Redirect href="/sign-in" />;
  if (!user) return <Redirect href="/register" />;
  return <Redirect href={HOME[user.role]} />;
}
