import { env } from '../../config/env';
import { query } from '../../db/pool';
import { logger } from '../../lib/logger';
import { firebaseMessaging } from '../firebase';
import { whatsapp } from '../messaging/whatsapp';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * Section 8 fallback: also send this to a technician via the central WhatsApp
   * number. Never used for customers — they're reached in-app only.
   */
  whatsapp?: boolean;
}

/**
 * Sends an FCM push to all of a user's registered devices and prunes tokens FCM
 * reports as dead. Without Firebase configured (dev/test) it only logs.
 */
export async function pushToUser(userId: string, msg: PushMessage): Promise<void> {
  const rows = await query<{ fcm_tokens: string[]; role: string; phone_e164: string | null }>('SELECT fcm_tokens, role, phone_e164 FROM users WHERE id = $1', [userId]);
  if (msg.whatsapp && rows[0]?.role === 'technician' && rows[0].phone_e164) {
    await whatsAppFallback(rows[0].phone_e164, msg);
  }
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

/**
 * Section 8 secondary channel: the central WhatsApp number notifies technicians.
 * Free-form text works inside WhatsApp's 24h service window; outside it we fall
 * back to the approved `technician_notification` template. Replies are routed
 * into the job's in-app chat thread by the relay.
 */
async function whatsAppFallback(phone: string, msg: PushMessage) {
  const ref = msg.data?.jobRef ? `[#${msg.data.jobRef}] ` : '';
  try {
    await whatsapp().sendText(phone, `${ref}${msg.title}: ${msg.body}${msg.data?.type === 'chat.message' ? '\n\nReply here and we\'ll pass it on in the app chat.' : ''}`);
  } catch {
    try {
      await whatsapp().sendTemplate(phone, 'technician_notification', [msg.title, msg.body.slice(0, 900)]);
    } catch (err2) {
      logger.warn({ err: err2 }, 'whatsapp fallback failed');
    }
  }
}
