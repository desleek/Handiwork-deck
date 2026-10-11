import express, { Router } from 'express';
import { env } from '../config/env.ts';
import { one, query, tx } from '../db/pool.ts';
import { HttpError } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { deliverMessage, routeInboundWhatsApp } from '../services/chat.ts';
import { parseInbound, verifyMetaSignature } from '../services/messaging/whatsapp.ts';
import { onPaymentSucceeded } from '../services/payments/escrow.ts';
import { markMockPaid } from '../services/payments/mock.ts';
import { getProvider, PROVIDERS } from '../services/payments/router.ts';
import { postLedger } from '../services/wallet.ts';

export const webhooks = Router();
// Signature checks need the exact bytes the provider sent.
webhooks.use(express.raw({ type: '*/*', limit: '1mb' }));

/** Gateway webhooks — verified, de-duplicated, then settled idempotently. */
webhooks.post('/payments/:provider', async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider || provider.name === 'mock') return res.status(404).end();
  const evt = provider.parseWebhook(req.headers, req.body as Buffer);
  if (!evt) return res.status(401).end();

  const fresh = await one(
    `INSERT INTO payment_webhook_events (provider, event_id, payload) VALUES ($1,$2,$3)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [provider.name, evt.eventId, JSON.stringify(evt.raw)],
  );
  res.status(200).end(); // acknowledge fast; providers retry on non-2xx
  if (!fresh) return;

  try {
    if (evt.type === 'charge.succeeded' || evt.type === 'charge.failed') {
      const p = await one<any>(
        `SELECT id, amount_minor, status FROM payments WHERE (provider = $1 AND provider_ref = $2) OR id::text = $3`,
        [provider.name, evt.providerRef, evt.reference ?? ''],
      );
      if (!p) return;
      if (evt.type === 'charge.failed') {
        await query(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'initiated'`, [p.id]);
      } else {
        // Never trust the webhook amount alone: verify with the provider's API.
        const v = await provider.verify(evt.providerRef);
        if (v.status === 'succeeded' && v.amountMinor >= p.amount_minor) await onPaymentSucceeded(p.id, v.feeMinor ?? null);
        else logger.warn({ paymentId: p.id, v }, 'webhook success not confirmed by verify');
      }
    } else if (evt.type === 'transfer.succeeded' || evt.type === 'transfer.failed') {
      const w = await one<any>(`SELECT * FROM withdrawals WHERE id::text = $1 OR provider_ref = $2`, [evt.reference ?? '', evt.providerRef]);
      if (!w || ['paid', 'reversed'].includes(w.status)) return;
      if (evt.type === 'transfer.succeeded') {
        await query(`UPDATE withdrawals SET status = 'paid', completed_at = now() WHERE id = $1`, [w.id]);
      } else {
        await tx(async (db) => {
          await query(`UPDATE withdrawals SET status = 'reversed' WHERE id = $1`, [w.id], db);
          await postLedger(db, { userId: w.user_id, type: 'withdrawal_reversal', amountMinor: w.amount_minor, description: 'Withdrawal failed — funds returned', withdrawalId: w.id });
        });
      }
    }
    await query(`UPDATE payment_webhook_events SET processed_at = now() WHERE provider = $1 AND event_id = $2`, [provider.name, evt.eventId]);
  } catch (err) {
    logger.error({ err, evt: evt.eventId }, 'webhook processing failed');
  }
});

/** Meta WhatsApp webhook verification handshake. */
webhooks.get('/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(String(req.query['hub.challenge']));
  }
  res.status(403).end();
});

/** Inbound WhatsApp replies from technicians → routed into the in-app chat thread. */
webhooks.post('/whatsapp', async (req, res) => {
  const raw = req.body as Buffer;
  if (!verifyMetaSignature(raw, req.header('x-hub-signature-256'))) return res.status(401).end();
  res.status(200).end();
  const payload = JSON.parse(raw.toString('utf8'));
  for (const m of parseInbound(payload)) {
    try {
      const r = await tx((db) => routeInboundWhatsApp(db, m.from, m.text, m.id));
      if (r.routed) await deliverMessage(r.job, r.message.sender_id, r.message.body);
    } catch (err) {
      logger.warn({ err }, 'inbound whatsapp routing failed');
    }
  }
});

/** Payments API used by the app: poll status after returning from checkout. */
export const payments = Router();
payments.use(authenticate, requireUser());

payments.get('/:id', async (req, res) => {
  const p = await one<any>('SELECT id, purpose, job_id, channel, provider, amount_minor, currency, status, checkout, created_at FROM payments WHERE id = $1 AND payer_id = $2', [
    req.params.id,
    req.user!.id,
  ]);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Payment not found');
  // Pull-based confirmation in case the webhook hasn't arrived yet.
  if (p.status === 'initiated' && p.provider !== 'wallet') {
    const full = await one<any>('SELECT provider_ref FROM payments WHERE id = $1', [p.id]);
    try {
      const v = await getProvider(p.provider).verify(full.provider_ref);
      if (v.status === 'succeeded') {
        await onPaymentSucceeded(p.id, v.feeMinor ?? null);
        p.status = 'held';
      }
    } catch (err) {
      logger.warn({ err }, 'verify failed');
    }
  }
  res.json(p);
});

/** Development only: simulate the gateway confirming a mock payment. */
payments.post('/:id/mock-complete', async (req, res) => {
  if (!getProvider('mock').isConfigured()) return res.status(404).end();
  const p = await one<any>(`SELECT id, provider_ref FROM payments WHERE id = $1 AND payer_id = $2 AND provider = 'mock'`, [req.params.id, req.user!.id]);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Payment not found');
  markMockPaid(p.provider_ref);
  await onPaymentSucceeded(p.id, 0);
  res.json({ ok: true });
});
