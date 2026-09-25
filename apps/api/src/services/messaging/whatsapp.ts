import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export interface InboundWhatsAppMessage {
  waMessageId: string;
  fromE164: string; // "+2348012345678"
  text: string;
  timestamp: Date;
}

export interface WhatsAppClient {
  sendText(toE164: string, body: string): Promise<{ messageId?: string }>;
  sendTemplate(toE164: string, template: string, params: string[], lang?: string): Promise<{ messageId?: string }>;
}

/** WhatsApp Cloud API (Meta Graph) client for the central platform-owned number. */
export class CloudApiWhatsAppClient implements WhatsAppClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(payload: Record<string, unknown>) {
    const res = await this.fetchImpl(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`WhatsApp send failed: ${json.error?.message ?? res.status}`);
    return { messageId: json.messages?.[0]?.id };
  }

  sendText(toE164: string, body: string) {
    return this.post({ to: toE164.replace(/^\+/, ''), type: 'text', text: { body, preview_url: false } });
  }

  /** Business-initiated messages outside the 24h service window must use an approved template. */
  sendTemplate(toE164: string, template: string, params: string[], lang = 'en') {
    return this.post({
      to: toE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: template,
        language: { code: lang },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
      },
    });
  }
}

/** Logs instead of sending; used when WhatsApp credentials are not configured. */
export class LoggingWhatsAppClient implements WhatsAppClient {
  public readonly sent: { to: string; body: string }[] = [];
  async sendText(to: string, body: string) {
    this.sent.push({ to, body });
    logger.info({ to, body }, 'whatsapp (dry-run) text');
    return {};
  }
  async sendTemplate(to: string, template: string, params: string[]) {
    this.sent.push({ to, body: `[template:${template}] ${params.join(' | ')}` });
    logger.info({ to, template, params }, 'whatsapp (dry-run) template');
    return {};
  }
}

let client: WhatsAppClient | undefined;
export function whatsapp(): WhatsAppClient {
  if (!client) {
    client =
      env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN
        ? new CloudApiWhatsAppClient(env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_API_VERSION)
        : new LoggingWhatsAppClient();
  }
  return client;
}
export function setWhatsAppClient(c: WhatsAppClient) {
  client = c;
}

/** Validates Meta's `X-Hub-Signature-256` header against the raw request body. */
export function verifyWhatsAppSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return signatureHeader.length === expected.length && timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
}

/** Extracts text messages from a Cloud API webhook payload. Non-text messages are summarised. */
export function extractInboundMessages(payload: any): InboundWhatsAppMessage[] {
  const out: InboundWhatsAppMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        const text =
          m.type === 'text'
            ? m.text?.body
            : m.type === 'button'
              ? m.button?.text
              : m.type === 'interactive'
                ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
                : `[${m.type} message — please use the HANDIWORK-DECK app to share media]`;
        if (!m.id || !m.from || !text) continue;
        out.push({
          waMessageId: m.id,
          fromE164: `+${String(m.from).replace(/^\+/, '')}`,
          text: String(text),
          timestamp: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000),
        });
      }
    }
  }
  return out;
}

/** Optional leading job reference (e.g. "#HW-7K2QD ...") used to pick a conversation. */
export function parseJobRef(text: string): { ref?: string; body: string } {
  const m = /^\s*#(HW-[A-Z0-9]{5})\b[:\s-]*/i.exec(text);
  if (!m) return { body: text.trim() };
  return { ref: m[1]!.toUpperCase(), body: text.slice(m[0].length).trim() };
}

/** Deep link that opens WhatsApp to the platform number with the job ref prefilled. */
export function waDeepLink(jobRef: string): string | undefined {
  if (!env.WHATSAPP_DISPLAY_NUMBER) return undefined;
  return `https://wa.me/${env.WHATSAPP_DISPLAY_NUMBER}?text=${encodeURIComponent(`#${jobRef} `)}`;
}
