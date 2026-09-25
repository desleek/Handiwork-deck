import { env } from '../../config/env';
import { query } from '../../db/pool';
import { logger } from '../../lib/logger';
import { firebaseMessaging } from '../firebase';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Sends an FCM push to all of a user's registered devices and prunes tokens FCM
 * reports as dead. Without Firebase configured (dev/test) it only logs.
 */
export async function pushToUser(userId: string, msg: PushMessage): Promise<void> {
  const rows = await query<{ fcm_tokens: string[] }>('SELECT fcm_tokens FROM users WHERE id = $1', [userId]);
  const tokens = rows[0]?.fcm_tokens ?? [];
  if (!tokens.length) return;
  if (env.NODE_ENV !== 'production' && !env.FIREBASE_PROJECT_ID) {
    logger.info({ userId, msg }, 'push (dry-run)');
    return;
  }
  const res = await firebaseMessaging().sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    data: msg.data,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  });
  const dead = res.responses
    .map((r, i) => (!r.success && r.error?.code === 'messaging/registration-token-not-registered' ? tokens[i] : null))
    .filter((t): t is string => !!t);
  if (dead.length) {
    await query('UPDATE users SET fcm_tokens = array(SELECT unnest(fcm_tokens) EXCEPT SELECT unnest($2::text[])) WHERE id = $1', [
      userId,
      dead,
    ]);
  }
}
