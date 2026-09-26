import { CUSTOMER_TYPES } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool';
import { conflict } from '../lib/errors';
import { customerTrust } from '../services/ratings';
import { pendingReviewJobs } from '../services/reviews';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';

export const usersRouter = Router();

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in E.164 format, e.g. +2348012345678');

const RegisterBody = z
  .object({
    // Admins are provisioned by other admins, never self-registered.
    role: z.enum(['customer', 'technician', 'advertiser']),
    fullName: z.string().trim().min(2).max(120),
    email: z.email().optional(),
    phone: e164.optional(),
    customerType: z.enum(CUSTOMER_TYPES).optional(),
    companyName: z.string().trim().max(160).optional(),
  })
  .refine((b) => b.role !== 'customer' || b.customerType, { message: 'customerType is required for customers', path: ['customerType'] })
  .refine((b) => b.role === 'customer' || !b.customerType, { message: 'customerType is only valid for customers', path: ['customerType'] });

const USER_COLUMNS = 'id, role, full_name, email, phone_e164, customer_type, company_name, location_disclosure_accepted_at, created_at';

usersRouter.post('/auth/register', authenticate, async (req, res) => {
  if (req.user) throw conflict('Already registered');
  const body = parse(RegisterBody, req.body);
  // Prefer the phone number Firebase verified via SMS over a self-declared one.
  const phone = req.auth!.phone ?? body.phone ?? null;
  const user = await one(
    `INSERT INTO users (firebase_uid, role, full_name, email, phone_e164, customer_type, company_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${USER_COLUMNS}`,
    [req.auth!.uid, body.role, body.fullName, body.email ?? req.auth!.email ?? null, phone, body.customerType ?? null, body.companyName ?? null],
  );
  if (body.role === 'technician') {
    await query('INSERT INTO technician_profiles (user_id) VALUES ($1)', [user.id]);
  }
  res.status(201).json({ user });
});

usersRouter.get('/me', authenticate, requireUser(), async (req, res) => {
  const me = currentUser(req);
  const user = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [me.id]);
  res.json({ user: me.role === 'customer' ? { ...user, trust: await customerTrust(me.id) } : user });
});

const UpdateMe = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.email().optional(),
  companyName: z.string().trim().max(160).optional(),
});

usersRouter.patch('/me', authenticate, requireUser(), async (req, res) => {
  const b = parse(UpdateMe, req.body);
  const user = await one(
    `UPDATE users SET full_name = COALESCE($2, full_name), email = COALESCE($3, email), company_name = COALESCE($4, company_name)
      WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [currentUser(req).id, b.fullName ?? null, b.email ?? null, b.companyName ?? null],
  );
  res.json({ user });
});

usersRouter.post('/me/push-tokens', authenticate, requireUser(), async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(4096) }), req.body);
  await query(
    `UPDATE users SET fcm_tokens = (SELECT array_agg(DISTINCT t) FROM unnest(array_append(fcm_tokens, $2)) t) WHERE id = $1`,
    [currentUser(req).id, token],
  );
  res.status(204).end();
});

/** Completed jobs awaiting the customer's mandatory review (new bookings are blocked until done). */
usersRouter.get('/me/pending-reviews', authenticate, requireUser('customer'), async (req, res) => {
  res.json({ jobs: await pendingReviewJobs(currentUser(req).id) });
});
