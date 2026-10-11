import { logger } from '../../lib/logger.ts';
import { firebaseApp } from '../firebase.ts';

/**
 * Firebase Cloud Messaging — one API for APNs (iOS) and FCM (Android) (Section 14a).
 * Falls back to logging when Firebase credentials aren't configured.
 */
export async function sendPush(
  tokens: string[],
  msg: { title: string; body: string; data?: Record<string, string>; urgent?: boolean },
): Promise<string[]> {
  if (tokens.length === 0) return [];
  const app = await firebaseApp();
  if (!app) {
    logger.info({ tokens: tokens.length, msg }, '[push:dev] would send');
    return [];
  }
  const { getMessaging } = await import('firebase-admin/messaging');
  const res = await getMessaging(app).sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    data: msg.data,
    android: { priority: msg.urgent ? 'high' : 'normal', notification: { channelId: msg.urgent ? 'urgent' : 'default' } },
    apns: { payload: { aps: { sound: 'default', ...(msg.urgent ? { 'interruption-level': 'time-sensitive' } : {}) } } },
  });
  // Return tokens that are no longer valid so the caller can prune them.
  return res.responses
    .map((r: { success: boolean; error?: { code?: string } }, i: number) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null))
    .filter((t: string | null): t is string => !!t);
}
