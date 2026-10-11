import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Loading } from '../src/components/ui';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { flushOutbox, persister, queryClient } from '../src/lib/offline';
import { registerForPush } from '../src/lib/push';
import { useTheme } from '../src/theme';

function Gate() {
  const { state } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const t = useTheme();

  useEffect(() => {
    if (state.status === 'loading') return;
    const group = segments[0];
    if (state.status === 'signed_out' && group !== '(auth)') router.replace('/(auth)/sign-in');
    else if (state.status === 'needs_registration') router.replace('/(auth)/register');
    else if (state.status === 'ready') {
      const home = state.me.role === 'technician' ? '(technician)' : state.me.role === 'advertiser' ? '(seller)' : '(customer)';
      if (group === '(auth)' || group === undefined) router.replace(`/${home}`);
    }
  }, [state, segments, router]);

  useEffect(() => {
    if (state.status === 'ready') {
      flushOutbox();
      registerForPush().catch(() => {});
    }
  }, [state.status]);

  if (state.status === 'loading') return <Loading />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.color.surface },
        headerTintColor: t.color.text,
        contentStyle: { backgroundColor: t.color.bg },
        // iOS: native swipe-back; Android: system back button + Material slide.
        gestureEnabled: true,
        animation: Platform.OS === 'android' ? 'fade_from_bottom' : 'default',
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(customer)" options={{ headerShown: false }} />
      <Stack.Screen name="(technician)" options={{ headerShown: false }} />
      <Stack.Screen name="technician/[id]" options={{ title: 'Technician' }} />
      <Stack.Screen name="book/[technicianId]" options={{ title: 'Book', presentation: 'modal' }} />
      <Stack.Screen name="job/[id]/index" options={{ title: 'Job' }} />
      <Stack.Screen name="job/[id]/chat" options={{ title: 'Messages' }} />
      <Stack.Screen name="job/[id]/quote" options={{ title: 'Build quote' }} />
      <Stack.Screen name="job/[id]/challenge" options={{ title: 'Challenge a price', presentation: 'modal' }} />
      <Stack.Screen name="job/[id]/pay" options={{ title: 'Payment', presentation: 'modal' }} />
      <Stack.Screen name="promote" options={{ title: 'Promote' }} />
      <Stack.Screen name="job/[id]/boq" options={{ title: 'Bill of Quantities' }} />
      <Stack.Screen name="supplies/index" options={{ title: 'Supplies' }} />
      <Stack.Screen name="supplies/[id]" options={{ title: 'Product' }} />
      <Stack.Screen name="supplies/cart" options={{ title: 'Cart' }} />
      <Stack.Screen name="supplies/orders" options={{ title: 'My orders' }} />
      <Stack.Screen name="(seller)" options={{ headerShown: false }} />
      <Stack.Screen name="seller/product" options={{ title: 'Product', presentation: 'modal' }} />
      {/* Mandatory review: no back gesture, no header back — it's quick, not punitive. */}
      <Stack.Screen name="job/[id]/rate" options={{ title: 'Rate your job', gestureEnabled: false, headerBackVisible: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 }}>
      <AuthProvider>
        <StatusBar style="auto" />
        <Gate />
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}
