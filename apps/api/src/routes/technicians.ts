import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { getProvider, providerForCurrency } from '../services/payments/index';

export const techniciansRouter = Router();
const techOnly = [authenticate, requireUser('technician')];

const ProfileBody = z.object({
  bio: z.string().max(2000).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  isAvailable: z.boolean().optional(),
  baseLat: z.number().min(-90).max(90).optional(),
  baseLng: z.number().min(-180).max(180).optional(),
  serviceRadiusKm: z.number().min(1).max(500).optional(),
});

techniciansRouter.put('/technicians/me', ...techOnly, async (req, res) => {
  const b = parse(ProfileBody, req.body);
  const profile = await one(
    `UPDATE technician_profiles SET
       bio = COALESCE($2, bio), years_experience = COALESCE($3, years_experience),
       is_available = COALESCE($4, is_available), base_lat = COALESCE($5, base_lat),
       base_lng = COALESCE($6, base_lng), service_radius_km = COALESCE($7, service_radius_km)
     WHERE user_id = $1 RETURNING *`,
    [currentUser(req).id, b.bio ?? null, b.yearsExperience ?? null, b.isAvailable ?? null, b.baseLat ?? null, b.baseLng ?? null, b.serviceRadiusKm ?? null],
  );
  res.json({ profile });
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
  const file = await one(`SELECT id FROM files WHERE id = $1 AND owner_id = $2 AND kind = 'portfolio'`, [b.fileId, techId]);
  if (!file) throw notFound('Portfolio file');
  const item = await one(
    'INSERT INTO portfolio_items (technician_id, file_id, caption, category_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [techId, b.fileId, b.caption ?? null, b.categoryId ?? null],
  );
  res.status(201).json({ item });
});

/** Public technician profile shown to customers (no contact details). */
techniciansRouter.get('/technicians/:id', authenticate, requireUser(), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const profile = await one(
    `SELECT u.id, u.full_name, u.company_name, tp.bio, tp.years_experience, tp.verification_status,
            tp.rating_avg, tp.rating_count, tp.is_available
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
      WHERE u.id = $1 AND u.is_active`,
    [id],
  );
  if (!profile) throw notFound('Technician');
  const [services, portfolio, reviews] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.segment, ts.base_rate_minor, ts.currency
         FROM technician_services ts JOIN service_categories c ON c.id = ts.category_id WHERE ts.technician_id = $1`,
      [id],
    ),
    query(
      `SELECT p.id, p.caption, p.category_id, f.url FROM portfolio_items p JOIN files f ON f.id = p.file_id
        WHERE p.technician_id = $1 ORDER BY p.created_at DESC LIMIT 30`,
      [id],
    ),
    query(
      `SELECT r.rating, r.comment, r.created_at, split_part(u.full_name, ' ', 1) AS reviewer
         FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
      [id],
    ),
  ]);
  res.json({ technician: { ...profile, services, portfolio, reviews } });
});
