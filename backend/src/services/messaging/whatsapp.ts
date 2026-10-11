import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.ts';
import { logger } from '../../lib/logger.ts';

/**
 * WhatsApp Business relay through ONE platform-owned number (Section 8).
 * Provider abstraction so Meta Cloud API, Twilio or 360dialog can be swapped (open decision, Section 22).
 * Default implementation: Meta Cloud API.
 */
export interface WhatsAppProvider {
  readonly name: string;
  /** Free-form text — only allowed inside WhatsApp's 24h customer-service window. */
  sendText(toE164: string, body: string): Promise<{ messageId: string | null }>;
  /** Pre-approved template — required to start a conversation or outside the 24h window. */
  sendTemplate(toE164: string, template: string, params: string[]): Promise<{ messageId: string | null }>;
}

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(body: object) {
  const res = await fetch(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp send failed: ${json.error?.message ?? res.status}`);
  return { messageId: json.messages?.[0]?.id ?? null };
}

const metaCloud: WhatsAppProvider = {
  name: 'meta',
  sendText: (to, body) => graph({ to: to.replace('+', ''), type: 'text', text: { body, preview_url: false } }),
  sendTemplate: (to, template, params) =>
    graph({
      to: to.replace('+', ''),
      type: 'template',
      template: {
        name: template,
        language: { code: 'en' },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    }),
};

const devLogger: WhatsAppProvider = {
  name: 'dev',
  async sendText(to, body) {
    logger.info({ to: to.slice(0, 6) + '…', body }, '[whatsapp:dev] text');
    return { messageId: null };
  },
  async sendTemplate(to, template, params) {
    logger.info({ to: to.slice(0, 6) + '…', template, params }, '[whatsapp:dev] template');
    return { messageId: null };
  },
};

export const whatsapp: WhatsAppProvider =
  env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN ? metaCloud : devLogger;

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!env.WHATSAPP_APP_SECRET) return env.NODE_ENV !== 'production';
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET).update(rawBody).digest('hex');
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Normalise Meta's inbound webhook into plain messages. */
export function parseInbound(payload: any): { from: string; text: string; id: string; contextId?: string }[] {
  const out: { from: string; text: string; id: string; contextId?: string }[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title;
        if (text) out.push({ from: `+${m.from}`, text, id: m.id, contextId: m.context?.id });
      }
    }
  }
  return out;
}
