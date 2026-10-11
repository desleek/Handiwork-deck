import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { onlineManager, QueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { api, ApiError } from '../api/client';

/**
 * Poor-connectivity handling (Section 14a):
 *  - React Query cache is persisted to disk, so active jobs, quotes and chat render offline.
 *  - Queries pause while offline and refetch on reconnect.
 *  - Outgoing chat messages go through a durable queue keyed by a client message id; the API
 *    de-duplicates on that id, so retries can never double-send.
 */
onlineManager.setEventListener((setOnline) => NetInfo.addEventListener((s) => setOnline(!!s.isConnected)));

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 1000 * 60 * 60 * 24,
      retry: (count, err) => (err instanceof ApiError ? err.retryable && count < 3 : count < 3),
      networkMode: 'offlineFirst',
    },
    mutations: { networkMode: 'offlineFirst', retry: (count, err) => err instanceof ApiError && err.retryable && count < 2 },
  },
});

export const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: 'hw.query-cache' });

// ------------------------------------------------------------------ chat outbox
export interface OutboxMessage {
  jobId: string;
  clientMsgId: string;
  body: string;
  createdAt: string;
}

const OUTBOX_KEY = 'hw.chat-outbox';
let flushing = false;
const listeners = new Set<() => void>();

async function readOutbox(): Promise<OutboxMessage[]> {
  return JSON.parse((await AsyncStorage.getItem(OUTBOX_KEY)) ?? '[]');
}
async function writeOutbox(items: OutboxMessage[]) {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  listeners.forEach((l) => l());
}

export function onOutboxChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function pendingFor(jobId: string) {
  return (await readOutbox()).filter((m) => m.jobId === jobId);
}

export async function enqueueMessage(jobId: string, body: string) {
  const msg: OutboxMessage = { jobId, body, clientMsgId: Crypto.randomUUID(), createdAt: new Date().toISOString() };
  await writeOutbox([...(await readOutbox()), msg]);
  flushOutbox();
  return msg;
}

export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    let items = await readOutbox();
    for (const m of items) {
      try {
        await api(`/jobs/${m.jobId}/messages`, { body: { body: m.body, clientMsgId: m.clientMsgId } });
        items = items.filter((x) => x.clientMsgId !== m.clientMsgId);
        await writeOutbox(items);
        queryClient.invalidateQueries({ queryKey: ['messages', m.jobId] });
      } catch (err) {
        if (err instanceof ApiError && !err.retryable) {
          // Permanently rejected (e.g. conversation closed): drop it rather than retrying forever.
          items = items.filter((x) => x.clientMsgId !== m.clientMsgId);
          await writeOutbox(items);
        } else break; // offline — try again on reconnect
      }
    }
  } finally {
    flushing = false;
  }
}

NetInfo.addEventListener((s) => {
  if (s.isConnected) flushOutbox();
});
