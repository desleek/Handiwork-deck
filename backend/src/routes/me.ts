import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { one, query, tx } from '../db/pool.ts';
import { conflict, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { getSettings } from '../services/settings.ts';
import { pendingReviewJobIds } from '../services/ratings.ts';
import { activeRestrictions } from '../services/restrictions.ts';
import { createSignedUpload, type UploadKind } from '../services/storage.ts';

export const me = Router();
me.use(authenticate);

const RegisterBody = z.object({
  role: z.enum(['customer', 'technician']), // advertisers & admins are created by admins
  fullName: z.string().trim().min(2).max(100),
  email: z.string().email().optional(),
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +2348031234567'),
});

/** First call after Firebase sign-up. Creates the platform user (and technician profile). */
me.post('/register', async (req, res) => {
  if (req.user) throw conflict('ALREADY_REGISTERED', 'Account already exists');
  const b = parse(RegisterBody, req.body);
  const s = await getSettings();
  const user = await tx(async (db) => {
    const u = await one(
      `INSERT INTO users (id, firebase_uid, role, full_name, email, phone_e164, wallet_bonus_until)
       VALUES (COALESCE($7::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, now() + make_interval(days => $6))
       RETURNING id, role, full_name, email, status, created_at`,
      [
        env.AUTH_MODE === 'dev' ? null : req.firebaseUid,
        b.role,
        b.fullName,
        b.email ?? req.firebaseClaims?.email ?? null,
        b.phoneE164,
        s.walletBonusWindowDays,
        // Dev mode: the x-dev-user-id header becomes the user id so later requests resolve to it.
        env.AUTH_MODE === 'dev' ? req.firebaseUid!.slice(4) : null,
      ],
      db,
    );
    await query('INSERT INTO wallets (user_id) VALUES ($1)', [u.id], db);
    await query('INSERT INTO notification_prefs (user_id) VALUES ($1)', [u.id], db);
    if (b.role === 'technician') await query('INSERT INTO technician_profiles (user_id) VALUES ($1)', [u.id], db);
    return u;
  });
  res.status(201).json(user);
});

me.get('/', requireUser(), async (req, res) => {
  const u = req.user!;
  const [profile, restrictions, pendingReviews] = await Promise.all([
    one('SELECT id, role, full_name, email, phone_e164, avatar_url, status, completion_badge, created_at FROM users WHERE id = $1', [u.id]),
    activeRestrictions(u.id),
    u.role === 'customer' ? pendingReviewJobIds(u.id) : Promise.resolve([]),
  ]);
  res.json({ ...profile, restrictions, pendingReviewJobIds: pendingReviews });
});

me.patch('/', requireUser(), async (req, res) => {
  const b = parse(z.object({ fullName: z.string().trim().min(2).max(100).optional(), avatarUrl: z.string().url().optional() }), req.body);
  const u = await one(
    `UPDATE users SET full_name = COALESCE($2, full_name), avatar_url = COALESCE($3, avatar_url), updated_at = now()
     WHERE id = $1 RETURNING id, full_name, avatar_url`,
    [req.user!.id, b.fullName ?? null, b.avatarUrl ?? null],
  );
  res.json(u);
});

me.post('/devices', requireUser(), async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), platform: z.enum(['ios', 'android']) }), req.body);
  await query(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [req.user!.id, b.token, b.platform],
  );
  res.status(204).end();
});

me.put('/notification-prefs', requireUser(), async (req, res) => {
  const b = parse(z.object({ promotionalAlerts: z.boolean() }), req.body);
  await query(
    `INSERT INTO notification_prefs (user_id, promotional_alerts) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET promotional_alerts = EXCLUDED.promotional_alerts, updated_at = now()`,
    [req.user!.id, b.promotionalAlerts],
  );
  res.status(204).end();
});

me.get('/notifications', requireUser(), async (req, res) => {
  res.json(await query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user!.id]));
});

me.post('/uploads', requireUser(), async (req, res) => {
  const b = parse(
    z.object({
      kind: z.enum(['portfolio', 'receipt', 'evidence', 'id_document', 'certification', 'boq', 'avatar', 'product', 'ad_creative']),
      contentType: z.string(),
      size: z.number().int().positive(),
    }),
    req.body,
  );
  res.json(await createSignedUpload(req.user!.id, b.kind as UploadKind, b.contentType, b.size));
});

/**
 * Account deletion (App Store / Play requirement). Personal data is anonymised; job, payment and
 * review records are retained in anonymised form for financial/legal audit.
 */
me.delete('/', requireUser(), async (req, res) => {
  const uid = req.user!.id;
  const open = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs WHERE (customer_id = $1 OR technician_id = $1)
       AND status IN ('funded', 'en_route', 'in_progress', 'awaiting_confirmation', 'disputed')`,
    [uid],
  );
  if (open!.n > 0) throw conflict('OPEN_JOBS', 'Finish or cancel your active jobs before deleting your account');
  const balance = await one<{ balance_minor: number }>('SELECT balance_minor FROM wallets WHERE user_id = $1', [uid]);
  if ((balance?.balance_minor ?? 0) > 0) throw conflict('WALLET_NOT_EMPTY', 'Withdraw your wallet balance before deleting your account');
  await tx(async (db) => {
    await query(
      `UPDATE users SET status = 'deleted', deleted_at = now(), firebase_uid = NULL, full_name = 'Deleted user',
         email = NULL, phone_e164 = NULL, avatar_url = NULL WHERE id = $1`,
      [uid],
      db,
    );
    await query('DELETE FROM device_tokens WHERE user_id = $1', [uid], db);
    await query('DELETE FROM bank_accounts WHERE user_id = $1', [uid], db);
    await query(`UPDATE technician_profiles SET is_online = false, last_lat = NULL, last_lng = NULL, id_document_url = NULL WHERE user_id = $1`, [uid], db);
    await query('DELETE FROM portfolio_images WHERE technician_id = $1', [uid], db);
  });
  // The client also deletes the Firebase Auth user.
  res.status(204).end();
});

me.post('/appeals', requireUser(), async (req, res) => {
  const b = parse(z.object({ restrictionId: z.string().uuid(), statement: z.string().trim().min(20).max(4000) }), req.body);
  const s = await getSettings();
  const r = await one<{ created_at: Date; tier: number }>(
    'SELECT created_at, tier FROM account_restrictions WHERE id = $1 AND user_id = $2',
    [b.restrictionId, req.user!.id],
  );
  if (!r) throw conflict('NO_RESTRICTION', 'Restriction not found');
  if (Date.now() - r.created_at.getTime() > s.appealWindowDays * 86_400_000) throw conflict('APPEAL_WINDOW_CLOSED', 'The appeal window has closed');
  const a = await one(
    'INSERT INTO appeals (user_id, restriction_id, statement) VALUES ($1, $2, $3) RETURNING *',
    [req.user!.id, b.restrictionId, b.statement],
  );
  res.status(201).json(a);
});

me.post('/reports', requireUser(), async (req, res) => {
  const b = parse(
    z.object({
      targetType: z.enum(['portfolio_image', 'review', 'chat_message', 'user', 'ad']),
      targetId: z.string().uuid(),
      reason: z.string().trim().min(3).max(1000),
    }),
    req.body,
  );
  await query('INSERT INTO content_reports (reporter_id, target_type, target_id, reason) VALUES ($1,$2,$3,$4)', [
    req.user!.id, b.targetType, b.targetId, b.reason,
  ]);
  res.status(201).json({ ok: true });
});

me.post('/supplies-waitlist', requireUser(), async (req, res) => {
  await query('INSERT INTO supplies_waitlist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.user!.id]);
  res.status(204).end();
});
