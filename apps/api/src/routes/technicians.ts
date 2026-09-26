import { LABOR_ONLY_POLICIES, reviewTags, REVIEW_CATEGORIES } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { getProvider, providerForCurrency } from '../services/payments/index';
import { performanceFor } from '../services/ratings';
import { getSetting } from '../services/settings';

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
  /** IANA zone for the availability calendar, e.g. Africa/Lagos. */
  timezone: z.string().min(3).max(64).optional(),
  instantBookEnabled: z.boolean().optional(),
});

techniciansRouter.put('/technicians/me', ...techOnly, async (req, res) => {
  const b = parse(ProfileBody, req.body);
  const techId = currentUser(req).id;
  if (b.timezone && !Intl.supportedValuesOf('timeZone').includes(b.timezone)) throw badRequest('Unknown timezone');
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
       timezone = COALESCE($10, timezone), instant_book_enabled = COALESCE($11, instant_book_enabled)
     WHERE user_id = $1 RETURNING *`,
    [
      techId, b.bio ?? null, b.yearsExperience ?? null, b.isAvailable ?? null, b.baseLat ?? null, b.baseLng ?? null,
      b.serviceRadiusKm ?? null, b.headline ?? null, b.avatarFileId ?? null, b.timezone ?? null, b.instantBookEnabled ?? null,
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
        /** Section 4: per-category labor-only declaration ("Accept" / "Decline from inception"). */
        laborOnly: z.enum(LABOR_ONLY_POLICIES),
      }),
    )
    .min(1)
    .max(30),
});

/** Latest declaration for (technician, category), including for services since removed. */
async function lastDeclaration(db: any, techId: string, categoryId: number) {
  return one<{ policy: string; declared_at: Date }>(
    `SELECT policy, declared_at FROM technician_labor_only_declarations
      WHERE technician_id = $1 AND category_id = $2 ORDER BY declared_at DESC, id DESC LIMIT 1`,
    [techId, categoryId],
    db,
  );
}

/** Rejects a declaration change inside the cooldown window. Returns true if a new declaration must be recorded. */
async function checkDeclaration(db: any, techId: string, categoryId: number, policy: string, cooldownDays: number): Promise<boolean> {
  const last = await lastDeclaration(db, techId, categoryId);
  if (!last) return true;
  if (last.policy === policy) return false;
  const nextAllowed = new Date(new Date(last.declared_at).getTime() + cooldownDays * 86_400_000);
  if (nextAllowed > new Date()) {
    throw new HttpError(409, `Labor-only declarations can be switched once every ${cooldownDays} days`, 'labor_only_cooldown', {
      categoryId,
      currentPolicy: last.policy,
      nextChangeAllowedAt: nextAllowed.toISOString(),
    });
  }
  return true;
}

/**
 * Replaces the technician's list of offered services. Every service carries a
 * labor-only declaration; declarations are permanent unless switched, and a
 * switch is only allowed once per cooldown period (even across remove/re-add).
 */
techniciansRouter.put('/technicians/me/services', ...techOnly, async (req, res) => {
  const { services } = parse(ServicesBody, req.body);
  const techId = currentUser(req).id;
  const cooldown = await getSetting('labor_only_cooldown_days');
  await tx(async (db) => {
    const inactive = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM service_categories WHERE id = ANY($1) AND (NOT is_active OR is_other)',
      [services.map((s) => s.categoryId)],
      db,
    );
    if (inactive?.n) throw badRequest('One or more categories are not available');
    const record: typeof services = [];
    for (const s of services) if (await checkDeclaration(db, techId, s.categoryId, s.laborOnly, cooldown)) record.push(s);
    await db.query('DELETE FROM technician_services WHERE technician_id = $1', [techId]);
    for (const s of services) {
      await db.query(
        'INSERT INTO technician_services (technician_id, category_id, base_rate_minor, currency, labor_only_policy) VALUES ($1, $2, $3, $4, $5)',
        [techId, s.categoryId, s.baseRateMinor ?? null, s.currency ?? null, s.laborOnly],
      );
    }
    for (const s of record) {
      await db.query('INSERT INTO technician_labor_only_declarations (technician_id, category_id, policy) VALUES ($1, $2, $3)', [techId, s.categoryId, s.laborOnly]);
    }
  });
  res.json({ services });
});

/** Switch a single category's labor-only declaration (subject to the cooldown). */
techniciansRouter.put('/technicians/me/services/:categoryId/labor-only', ...techOnly, async (req, res) => {
  const categoryId = parse(z.coerce.number().int().positive(), req.params.categoryId);
  const { policy } = parse(z.object({ policy: z.enum(LABOR_ONLY_POLICIES) }), req.body);
  const techId = currentUser(req).id;
  const cooldown = await getSetting('labor_only_cooldown_days');
  await tx(async (db) => {
    const svc = await one('SELECT 1 FROM technician_services WHERE technician_id = $1 AND category_id = $2 FOR UPDATE', [techId, categoryId], db);
    if (!svc) throw notFound('Service');
    if (!(await checkDeclaration(db, techId, categoryId, policy, cooldown))) return;
    await db.query('UPDATE technician_services SET labor_only_policy = $3 WHERE technician_id = $1 AND category_id = $2', [techId, categoryId, policy]);
    await db.query('INSERT INTO technician_labor_only_declarations (technician_id, category_id, policy) VALUES ($1, $2, $3)', [techId, categoryId, policy]);
  });
  res.json({ categoryId, policy });
});

// ---------------------------------------------------------------- availability calendar
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const AvailabilityBody = z.object({
  timezone: z.string().min(3).max(64).optional(),
  /** Weekly working hours; empty = no fixed hours (available whenever marked available). */
  weekly: z
    .array(z.object({ day: z.number().int().min(0).max(6), start: Time, end: Time }).refine((w) => w.start < w.end, 'start must be before end'))
    .max(28),
});

techniciansRouter.put('/technicians/me/availability', ...techOnly, async (req, res) => {
  const b = parse(AvailabilityBody, req.body);
  const techId = currentUser(req).id;
  if (b.timezone && !Intl.supportedValuesOf('timeZone').includes(b.timezone)) throw badRequest('Unknown timezone');
  await tx(async (db) => {
    if (b.timezone) await db.query('UPDATE technician_profiles SET timezone = $2 WHERE user_id = $1', [techId, b.timezone]);
    await db.query('DELETE FROM technician_availability WHERE technician_id = $1', [techId]);
    for (const w of b.weekly) {
      await db.query('INSERT INTO technician_availability (technician_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)', [techId, w.day, w.start, w.end]);
    }
  });
  res.json(await availabilityOf(techId));
});

techniciansRouter.get('/technicians/me/availability', ...techOnly, async (req, res) => {
  res.json(await availabilityOf(currentUser(req).id));
});

const TimeOffBody = z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), reason: z.string().max(200).optional() }).refine((b) => b.startsAt < b.endsAt, 'startsAt must be before endsAt');

techniciansRouter.post('/technicians/me/time-off', ...techOnly, async (req, res) => {
  const b = parse(TimeOffBody, req.body);
  const row = await one(
    'INSERT INTO technician_time_off (technician_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4) RETURNING *',
    [currentUser(req).id, b.startsAt, b.endsAt, b.reason ?? null],
  );
  res.status(201).json({ timeOff: row });
});

techniciansRouter.delete('/technicians/me/time-off/:id', ...techOnly, async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const row = await one('DELETE FROM technician_time_off WHERE id = $1 AND technician_id = $2 RETURNING id', [id, currentUser(req).id]);
  if (!row) throw notFound('Time off');
  res.status(204).end();
});

export async function availabilityOf(techId: string) {
  const [profile, weekly, timeOff] = await Promise.all([
    one('SELECT timezone, technician_available_at(user_id, now()) AS available_now FROM technician_profiles WHERE user_id = $1', [techId]),
    query(`SELECT day_of_week AS day, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS end FROM technician_availability WHERE technician_id = $1 ORDER BY 1, 2`, [techId]),
    query('SELECT id, starts_at, ends_at, reason FROM technician_time_off WHERE technician_id = $1 AND ends_at > now() ORDER BY starts_at', [techId]),
  ]);
  return { timezone: profile?.timezone, availableNow: profile?.available_now ?? false, weekly, timeOff };
}

// ---------------------------------------------------------------- onboarding
/** Section 4 onboarding checklist: ID/certification, services + labor-only declarations, coverage area, availability. */
techniciansRouter.get('/technicians/me/onboarding', ...techOnly, async (req, res) => {
  const techId = currentUser(req).id;
  const s = await one(
    `SELECT tp.verification_status, tp.onboarding_completed_at,
            EXISTS (SELECT 1 FROM files f WHERE f.owner_id = tp.user_id AND f.kind = 'id_document') AS has_id,
            EXISTS (SELECT 1 FROM technician_certifications c WHERE c.technician_id = tp.user_id) AS has_cert,
            EXISTS (SELECT 1 FROM technician_services ts WHERE ts.technician_id = tp.user_id) AS has_services,
            tp.base_lat IS NOT NULL AND tp.service_radius_km > 0 AS has_coverage,
            EXISTS (SELECT 1 FROM technician_availability a WHERE a.technician_id = tp.user_id) AS has_availability,
            (SELECT count(*) FROM portfolio_items p WHERE p.technician_id = tp.user_id)::int AS portfolio_count,
            tp.payout_provider IS NOT NULL AS has_payout
       FROM technician_profiles tp WHERE tp.user_id = $1`,
    [techId],
  );
  const steps = [
    { key: 'identity', label: 'Upload ID or a certification', done: s.has_id || s.has_cert, required: true },
    { key: 'services', label: 'Choose services and declare labor-only for each', done: s.has_services, required: true },
    { key: 'coverage', label: 'Set your base location and coverage radius', done: s.has_coverage, required: true },
    { key: 'availability', label: 'Set your weekly availability', done: s.has_availability, required: true },
    { key: 'portfolio', label: `Add portfolio photos (${s.portfolio_count}/${MAX_PORTFOLIO_ITEMS})`, done: s.portfolio_count > 0, required: false },
    { key: 'payouts', label: 'Set up payouts', done: s.has_payout, required: false },
  ];
  const complete = steps.every((st) => !st.required || st.done);
  if (complete && !s.onboarding_completed_at) await query('UPDATE technician_profiles SET onboarding_completed_at = now() WHERE user_id = $1', [techId]);
  res.json({ steps, complete, verificationStatus: s.verification_status });
});

const PayoutBody = z.object({
  currency: z.string().length(3).toUpperCase(),
  country: z.string().length(2).toUpperCase(),
  bank: z.object({ bankCode: z.string().min(2), accountNumber: z.string().min(6).max(20) }).optional(),
  returnUrl: z.url().optional(),
});

/** Creates the technician's payee account (for split payments and payouts) on the provider serving their currency. */
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
    currency: b.currency,
    bank: b.bank,
    returnUrl: b.returnUrl,
  });
  await query(
    `UPDATE technician_profiles SET payout_provider = $2, payout_account_ref = $3, payout_recipient_ref = $4, payout_currency = $5,
            payout_bank_code = $6, payout_account_number = $7
      WHERE user_id = $1`,
    [user.id, providerName, result.accountRef, result.recipientRef ?? null, b.currency, b.bank?.bankCode ?? null, b.bank?.accountNumber ?? null],
  );
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
            tp.rating_avg, tp.rating_count, tp.is_available, tp.instant_book_enabled,
            (SELECT url FROM files f WHERE f.id = tp.avatar_file_id) AS avatar_url
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
      WHERE u.id = $1 AND u.is_active`,
    [id],
  );
  if (!profile) throw notFound('Technician');
  const [services, portfolio, reviews, certifications, categoryScores, performance] = await Promise.all([
    query(
      `SELECT c.id, c.name, c.segment, c.icon, ts.base_rate_minor, ts.currency, ts.labor_only_policy,
              -- Section 7a: the publicly displayed standard rate includes the performance adjustment.
              round(ts.base_rate_minor * (1 + COALESCE(tp.rate_override_bps, tp.rate_adjustment_bps) / 10000.0))::bigint AS standard_rate_minor,
              (SELECT max(d.declared_at) FROM technician_labor_only_declarations d WHERE d.technician_id = ts.technician_id AND d.category_id = ts.category_id) AS labor_only_declared_at
         FROM technician_services ts JOIN service_categories c ON c.id = ts.category_id
         JOIN technician_profiles tp ON tp.user_id = ts.technician_id
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
  const availability = await availabilityOf(id);
  res.json({
    technician: {
      ...profile,
      services,
      portfolio,
      certifications,
      categoryScores,
      performance: performance.get(id),
      availability: { timezone: availability.timezone, availableNow: availability.availableNow, weekly: availability.weekly },
      reviews: reviews.map((r: any) => ({ ...r, tags: reviewTags(r.scores) })),
    },
  });
});
