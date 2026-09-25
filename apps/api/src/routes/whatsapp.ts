import express, { Router } from 'express';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { relayInbound } from '../services/messaging/relay';
import { extractInboundMessages, verifyWhatsAppSignature } from '../services/messaging/whatsapp';

export const whatsappWebhookRouter = Router();

/** Meta's webhook verification handshake. */
whatsappWebhookRouter.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

whatsappWebhookRouter.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body as Buffer;
  if (env.WHATSAPP_APP_SECRET) {
    if (!verifyWhatsAppSignature(raw, req.header('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) {
      res.sendStatus(401);
      return;
    }
  } else if (env.NODE_ENV === 'production') {
    res.sendStatus(503);
    return;
  }
  const messages = extractInboundMessages(JSON.parse(raw.toString('utf8') || '{}'));
  // Always ack quickly; Meta retries on non-2xx. Failures are logged per message.
  const outcomes = [];
  for (const msg of messages) {
    try {
      outcomes.push((await relayInbound(msg)).status);
    } catch (err) {
      logger.error({ err, waMessageId: msg.waMessageId }, 'whatsapp relay failed');
      outcomes.push('error');
    }
  }
  res.json({ received: messages.length, outcomes });
});
