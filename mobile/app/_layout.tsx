import * as Bricolage from '@expo-google-fonts/bricolage-grotesque';
import * as Figtree from '@expo-google-fonts/figtree';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Loading } from '../src/components/ui';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { flushOutbox, persister, queryClient } from '../src/lib/offline';
import { registerForPush } from '../src/lib/push';
import { applyFonts, FONT_ALIASES, useTheme } from '../src/theme';

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
      {/* Redesigned screens draw their own headers (back button, title, status). */}
      <Stack.Screen name="technician/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="book/[technicianId]" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="job/[id]/index" options={{ headerShown: false }} />
      <Stack.Screen name="job/[id]/chat" options={{ title: 'Messages' }} />
      <Stack.Screen name="job/[id]/quote" options={{ title: 'Build quote' }} />
      <Stack.Screen name="job/[id]/challenge" options={{ title: 'Challenge a price', presentation: 'modal' }} />
      <Stack.Screen name="job/[id]/pay" options={{ headerShown: false, presentation: 'modal' }} />
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

/**
 * Pick a weight from an @expo-google-fonts package by suffix (e.g. "_700Bold") rather than by exact
 * export name, so a renamed export can't crash the app — the theme just falls back to system fonts.
 */
function pick(pkg: Record<string, unknown>, suffixes: string[]): number | undefined {
  for (const s of suffixes) {
    const key = Object.keys(pkg).find((k) => k.endsWith(s) && typeof pkg[k] === 'number');
    if (key) return pkg[key] as number;
  }
  return undefined;
}

const FONT_SOURCES = {
  [FONT_ALIASES.display]: pick(Bricolage as any, ['_800ExtraBold', '_700Bold']),
  [FONT_ALIASES.displayBold]: pick(Bricolage as any, ['_700Bold', '_600SemiBold']),
  [FONT_ALIASES.body]: pick(Figtree as any, ['_400Regular']),
  [FONT_ALIASES.bodyMedium]: pick(Figtree as any, ['_500Medium', '_400Regular']),
  [FONT_ALIASES.bodySemibold]: pick(Figtree as any, ['_600SemiBold', '_700Bold']),
  [FONT_ALIASES.bodyBold]: pick(Figtree as any, ['_700Bold', '_600SemiBold']),
};
const ALL_FONTS_FOUND = Object.values(FONT_SOURCES).every((v) => v !== undefined);

export default function RootLayout() {
  const [loaded, error] = useFonts(ALL_FONTS_FOUND ? (FONT_SOURCES as Record<string, number>) : {});
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (loaded || error || !ALL_FONTS_FOUND) {
      applyFonts(!!loaded && !error && ALL_FONTS_FOUND);
      setReady(true);
    }
  }, [loaded, error]);
  if (!ready) return null; // native splash stays up for the few ms fonts take to load

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 }}>
      <AuthProvider>
        <StatusBar style="auto" />
        <Gate />
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}
