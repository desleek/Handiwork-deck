import { LABOR_STANCES, reviewTags, REVIEW_CATEGORIES } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { getProvider, providerForCurrency } from '../services/payments/index';
import { performanceFor } from '../services/performance';

/** Section 3: technician profiles show at most this many portfolio images. */
export const MAX_PORTFOLIO_ITEMS = 5;

export const techniciansRouter = Router();
const techOnly = [authenticate, requireUser('technician')];

const ProfileBody = z.object({
  bio: z.string().max(2000).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  isAvailable: z.boolean().optional(),
  baseLat: z.number().min(-90).max(90).optional(),
  baseLng: z.number().min(-180).max(180).optional(),
  serviceRadiusKm: z.number().min(1).max(500).optional(),
  headline: z.string().trim().max(120).optional(),
  avatarFileId: z.uuid().optional(),
  laborStance: z.enum(LABOR_STANCES).optional(),
  instantBookEnabled: z.boolean().optional(),
});

techniciansRouter.put('/technicians/me', ...techOnly, async (req, res) => {
  const b = parse(ProfileBody, req.body);
  const techId = currentUser(req).id;
  if (b.avatarFileId) {
    const f = await one(`SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND kind = 'avatar'`, [b.avatarFileId, techId]);
    if (!f) throw notFound('Avatar file');
  }
  const profile = await one(
    `UPDATE technician_profiles SET
       bio = COALESCE($2, bio), years_experience = COALESCE($3, years_experience),
       is_available = COALESCE($4, is_available), base_lat = COALESCE($5, base_lat),
       base_lng = COALESCE($6, base_lng), service_radius_km = COALESCE($7, service_radius_km),
       headline = COALESCE($8, headline), avatar_file_id = COALESCE($9, avatar_file_id),
       labor_stance = COALESCE($10, labor_stance), instant_book_enabled = COALESCE($11, instant_book_enabled)
     WHERE user_id = $1 RETURNING *`,
    [
      techId, b.bio ?? null, b.yearsExperience ?? null, b.isAvailable ?? null, b.baseLat ?? null, b.baseLng ?? null,
      b.serviceRadiusKm ?? null, b.headline ?? null, b.avatarFileId ?? null, b.laborStance ?? null, b.instantBookEnabled ?? null,
    ],
  );
  res.json({ profile });
});

const PresenceBody = z.union([
  z.object({ online: z.literal(true), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  z.object({ online: z.literal(false) }),
]);

/**
 * Heartbeat from the technician app while online (every minute or so). Powers the
 * live positions on the customer's discovery map; positions older than 15 minutes
 * are treated as offline.
 */
techniciansRouter.put('/technicians/me/presence', ...techOnly, async (req, res) => {
  const b = parse(PresenceBody, req.body);
  if (b.online) {
    await query('UPDATE technician_profiles SET live_lat = $2, live_lng = $3, live_at = now() WHERE user_id = $1', [currentUser(req).id, b.lat, b.lng]);
  } else {
    await query('UPDATE technician_profiles SET live_lat = NULL, live_lng = NULL, live_at = NULL WHERE user_id = $1', [currentUser(req).id]);
  }
  res.status(204).end();
});

const ServicesBody = z.object({
  services: z
    .array(
      z.object({
        categoryId: z.number().int().positive(),
        baseRateMinor: z.number().int().min(0).optional(),
        currency: z.string().length(3).toUpperCase().optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** Replaces the technician's list of offered services. */
techniciansRouter.put('/technicians/me/services', ...techOnly, async (req, res) => {
  const { services } = parse(ServicesBody, req.body);
  const techId = currentUser(req).id;
  await tx(async (db) => {
    await db.query('DELETE FROM technician_services WHERE technician_id = $1', [techId]);
    for (const s of services) {
      await db.query(
        'INSERT INTO technician_services (technician_id, category_id, base_rate_minor, currency) VALUES ($1, $2, $3, $4)',
        [techId, s.categoryId, s.baseRateMinor ?? null, s.currency ?? null],
      );
    }
  });
  res.json({ services });
});

const PayoutBody = z.object({
  currency: z.string().length(3).toUpperCase(),
  country: z.string().length(2).toUpperCase(),
  bank: z.object({ bankCode: z.string().min(2), accountNumber: z.string().min(6).max(20) }).optional(),
  returnUrl: z.url().optional(),
});

/** Creates the technician's payee account on the provider that serves their currency. */
techniciansRouter.post('/technicians/me/payout-account', ...techOnly, async (req, res) => {
  const b = parse(PayoutBody, req.body);
  const user = currentUser(req);
  const providerName = providerForCurrency(b.currency);
  if ((providerName === 'paystack' || providerName === 'flutterwave') && !b.bank) {
    throw badRequest(`Bank details are required for ${providerName} payouts`);
  }
  const result = await getProvider(providerName).onboardPayee({
    userId: user.id,
    email: user.email ?? undefined,
    fullName: user.company_name ?? user.full_name,
    country: b.country,
    bank: b.bank,
    returnUrl: b.returnUrl,
  });
  await query('UPDATE technician_profiles SET payout_provider = $2, payout_account_ref = $3 WHERE user_id = $1', [
    user.id,
    providerName,
    result.accountRef,
  ]);
  res.status(201).json({ provider: providerName, onboardingUrl: result.onboardingUrl ?? null });
});

const PortfolioBody = z.object({
  fileId: z.uuid(),
  caption: z.string().max(500).optional(),
  categoryId: z.number().int().positive().optional(),
});

techniciansRouter.post('/technicians/me/portfolio', ...techOnly, async (req, res) => {
  const b = parse(PortfolioBody, req.body);
  const techId = currentUser(req).id;
  const item = await tx(async (db) => {
    // Lock the profile row so concurrent uploads can't exceed the cap.
    await db.query('SELECT 1 FROM technician_profiles WHERE user_id = $1 FOR UPDATE', [techId]);
    const file = await one(`SELECT id FROM files WHERE id = $1 AND owner_id = $2 AND kind = 'portfolio'`, [b.fileId, techId], db);
    if (!file) throw notFound('Portfolio file');
    const { n } = (await one<{ n: number }>('SELECT count(*)::int AS n FROM portfolio_items WHERE technician_id = $1', [techId], db))!;
    if (n >= MAX_PORTFOLIO_ITEMS) throw conflict(`Portfolio is limited to ${MAX_PORTFOLIO_ITEMS} images — remove one first`);
    return one(
      'INSERT INTO portfolio_items (technician_id, file_id, caption, category_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [techId, b.fileId, b.caption ?? null, b.categoryId ?? null],
      db,
    );
  });
  res.status(201).json({ item });
});

techniciansRouter.delete('/technicians/me/portfolio/:id', ...techOnly, async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const row = await one('DELETE FROM portfolio_items WHERE id = $1 AND technician_id = $2 RETURNING id', [id, currentUser(req).id]);
  if (!row) throw notFound('Portfolio item');
  res.status(204).end();
});

const CertificationBody = z.object({
  title: z.string().trim().min(2).max(160),
  issuer: z.string().trim().max(160).optional(),
  issuedOn: z.iso.date().optional(),
  expiresOn: z.iso.date().optional(),
  fileId: z.uuid().optional(),
});

techniciansRouter.post('/technicians/me/certifications', ...techOnly, async (req, res) => {
  const b = parse(CertificationBody, req.body);
  const techId = currentUser(req).id;
  if (b.fileId) {
    const f = await one(`SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND kind IN ('id_document', 'receipt', 'portfolio')`, [b.fileId, techId]);
    if (!f) throw notFound('Certificate file');
  }
  const certification = await one(
    `INSERT INTO technician_certifications (technician_id, title, issuer, issued_on, expires_on, file_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [techId, b.title, b.issuer ?? null, b.issuedOn ?? null, b.expiresOn ?? null, b.fileId ?? null],
  );
  res.status(201).json({ certification });
});

techniciansRouter.delete('/technicians/me/certifications/:id', ...techOnly, async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const row = await one('DELETE FROM technician_certifications WHERE id = $1 AND technician_id = $2 RETURNING id', [id, currentUser(req).id]);
  if (!row) throw notFound('Certification');
  res.status(204).end();
});

/**
 * Full public profile shown to customers: portfolio (max 5), reviews with
 * category-score tags, certifications, labor-only stance and the current
 * performance multiplier with its reasons. Never includes contact details.
 */
techniciansRouter.get('/technicians/:id', authenticate, requireUser(), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const profile = await one(
    `SELECT u.id, u.full_name, u.company_name, tp.headline, tp.bio, tp.years_experience, tp.verification_status,
            tp.rating_avg, tp.rating_count, tp.is_available, tp.labor_stance, tp.instant_book_enabled,
            (SELECT url FROM files f WHERE f.id = tp.avatar_file_id) AS avatar_url
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
      WHERE u.id = $1 AND u.is_active`,
    [id],
  );
  if (!profile) throw notFound('Technician');
  const [services, portfolio, reviews, certifications, categoryScores, performance] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.segment, c.icon, ts.base_rate_minor, ts.currency
         FROM technician_services ts JOIN service_categories c ON c.id = ts.category_id
        WHERE ts.technician_id = $1 AND c.is_active ORDER BY c.sort_order`,
      [id],
    ),
    query(
      `SELECT p.id, p.caption, p.category_id, f.url FROM portfolio_items p JOIN files f ON f.id = p.file_id
        WHERE p.technician_id = $1 ORDER BY p.created_at DESC LIMIT ${MAX_PORTFOLIO_ITEMS}`,
      [id],
    ),
    query(
      `SELECT r.id, r.overall, r.scores, r.comment, r.created_at, split_part(u.full_name, ' ', 1) AS reviewer, c.name AS category_name
         FROM reviews r JOIN users u ON u.id = r.reviewer_id JOIN jobs j ON j.id = r.job_id JOIN service_categories c ON c.id = j.category_id
        WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC LIMIT 30`,
      [id],
    ),
    query(
      `SELECT title, issuer, issued_on, expires_on, is_verified, (expires_on IS NOT NULL AND expires_on < current_date) AS expired
         FROM technician_certifications WHERE technician_id = $1 ORDER BY is_verified DESC, created_at DESC`,
      [id],
    ),
    one(
      `SELECT ${REVIEW_CATEGORIES.map((c) => `round(avg((scores->>'${c}')::numeric), 2)::float8 AS ${c}`).join(', ')}
         FROM reviews WHERE reviewee_id = $1 AND scores <> '{}'::jsonb`,
      [id],
    ),
    performanceFor([id]),
  ]);
  res.json({
    technician: {
      ...profile,
      services,
      portfolio,
      certifications,
      categoryScores,
      performance: performance.get(id),
      reviews: reviews.map((r) => ({ ...r, tags: reviewTags(r.scores) })),
    },
  });
});
