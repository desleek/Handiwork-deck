import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { InMemoryScheduler, jobs } from '../src/queues/index';
import { MockProvider } from '../src/services/payments/providers/mock';
import { processPayout } from '../src/services/payouts';
import { bearer, categoryId, dbAvailable, fullScores, resetDb } from './helpers';

const hasDb = await dbAvailable();
const app = createApp();
const scheduler = jobs() as InMemoryScheduler;
const as = (uid: string) => ({ Authorization: bearer(uid) });
const LAGOS = { lat: 6.6018, lng: 3.3515 };
const id: { [k: string]: string } = {};
let plumbing: number;
let electrical: number;

const U = { admin: 'admin', cust: 'cust', tech: 'tech', tech2: 'tech2' };

async function register(uid: string, phone: string, body: Record<string, unknown>) {
  const r = await request(app).post('/v1/auth/register').set('Authorization', bearer(uid, phone)).send(body);
  expect(r.status).toBe(201);
  return r.body.user.id as string;
}
async function fileFor(ownerId: string | undefined, kind: string) {
  const r = await pool.query(`INSERT INTO files (owner_id, kind, driver, storage_key, url) VALUES ($1, $2, 's3', gen_random_uuid()::text, 'https://cdn.example/f') RETURNING id`, [ownerId, kind]);
  return r.rows[0].id as string;
}
async function postJob(extra: Record<string, unknown> = {}) {
  const r = await request(app).post('/v1/jobs').set(as(U.cust)).send({ categoryId: plumbing, title: 'Fix water heater', address: '1 Test St', ...LAGOS, currency: 'NGN', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.job as { id: string; ref: string };
}
const labor = (amount: number) => ({ kind: 'labor', description: 'Labor', quantity: 1, unitPriceMinor: amount });
const part = (description: string, base: number, markupBps: number, extra: Record<string, unknown> = {}) => ({ kind: 'material', description, quantity: 1, unitPriceMinor: base, markupBps, ...extra });

async function quote(jobId: string, items: object[], uid = U.tech) {
  return request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(uid)).send({ items });
}
async function reviewAll() {
  const pending = await request(app).get('/v1/me/pending-reviews').set(as(U.cust));
  for (const j of pending.body.jobs) {
    await request(app).post(`/v1/jobs/${j.id}/review`).set(as(U.cust)).send({ scores: fullScores(5), comment: 'Good work, thanks' });
  }
}

describe.skipIf(!hasDb)('Sections 4, 5, 5a: technician flow, pricing model, Demand Notice', () => {
  beforeAll(async () => {
    await resetDb();
    plumbing = await categoryId('plumbing');
    electrical = await categoryId('electrical');
    id.admin = await register(U.admin, '+2348100000001', { role: 'customer', fullName: 'Ops Admin', customerType: 'office' });
    await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL WHERE id = $1`, [id.admin]);
    id.cust = await register(U.cust, '+2348100000002', { role: 'customer', fullName: 'Ada Customer', customerType: 'homeowner', email: 'ada@example.com' });
    id.tech = await register(U.tech, '+2348100000003', { role: 'technician', fullName: 'Tunde Tech', email: 'tunde@example.com' });
    id.tech2 = await register(U.tech2, '+2348100000004', { role: 'technician', fullName: 'Kemi Tech' });
  });
  beforeEach(() => scheduler.reset());
  afterAll(async () => {
    await pool.end();
  });

  // ------------------------------------------------------------------ Section 4 onboarding
  describe('onboarding', () => {
    it('walks the checklist: ID, services with labor-only declarations, coverage, availability', async () => {
      let ob = await request(app).get('/v1/technicians/me/onboarding').set(as(U.tech));
      expect(ob.body.complete).toBe(false);
      expect(ob.body.steps.filter((s: { done: boolean }) => !s.done).map((s: { key: string }) => s.key)).toEqual(
        expect.arrayContaining(['identity', 'services', 'coverage', 'availability']),
      );

      await fileFor(id.tech, 'id_document');
      // Services must carry a labor-only declaration.
      expect((await request(app).put('/v1/technicians/me/services').set(as(U.tech)).send({ services: [{ categoryId: plumbing }] })).status).toBe(400);
      const svc = await request(app).put('/v1/technicians/me/services').set(as(U.tech)).send({
        services: [
          { categoryId: plumbing, laborOnly: 'accept', baseRateMinor: 1_000_000, currency: 'NGN' },
          { categoryId: electrical, laborOnly: 'decline' },
        ],
      });
      expect(svc.status).toBe(200);
      await request(app).put('/v1/technicians/me').set(as(U.tech)).send({ baseLat: 6.6, baseLng: 3.35, serviceRadiusKm: 20 });
      const av = await request(app)
        .put('/v1/technicians/me/availability')
        .set(as(U.tech))
        .send({ timezone: 'Africa/Lagos', weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '23:59' })) });
      expect(av.status).toBe(200);
      expect(av.body.availableNow).toBe(true);

      ob = await request(app).get('/v1/technicians/me/onboarding').set(as(U.tech));
      expect(ob.body.complete).toBe(true);
      await request(app).post(`/v1/admin/technicians/${id.tech}/verification`).set(as(U.admin)).send({ status: 'verified' });

      // Second technician: same area, plumbing only.
      await request(app).put('/v1/technicians/me/services').set(as(U.tech2)).send({ services: [{ categoryId: plumbing, laborOnly: 'decline' }] });
      await request(app).put('/v1/technicians/me').set(as(U.tech2)).send({ baseLat: 6.61, baseLng: 3.36, serviceRadiusKm: 20 });
      await request(app).post(`/v1/admin/technicians/${id.tech2}/verification`).set(as(U.admin)).send({ status: 'verified' });
    });

    it('enforces the labor-only cooldown, even across removing and re-adding a service', async () => {
      const sw = await request(app).put(`/v1/technicians/me/services/${plumbing}/labor-only`).set(as(U.tech)).send({ policy: 'decline' });
      expect(sw.status).toBe(409);
      expect(sw.body.error.code).toBe('labor_only_cooldown');
      // Dropping plumbing and re-adding it with the other policy doesn't dodge the cooldown.
      await request(app).put('/v1/technicians/me/services').set(as(U.tech)).send({ services: [{ categoryId: electrical, laborOnly: 'decline' }] });
      const readd = await request(app).put('/v1/technicians/me/services').set(as(U.tech)).send({
        services: [{ categoryId: plumbing, laborOnly: 'decline' }, { categoryId: electrical, laborOnly: 'decline' }],
      });
      expect(readd.status).toBe(409);
      // Admin shortens the cooldown to 0: switching is allowed and logged.
      await request(app).put('/v1/admin/settings/labor_only_cooldown_days').set(as(U.admin)).send({ value: 0 });
      const restore = await request(app).put('/v1/technicians/me/services').set(as(U.tech)).send({
        services: [{ categoryId: plumbing, laborOnly: 'accept', baseRateMinor: 1_000_000, currency: 'NGN' }, { categoryId: electrical, laborOnly: 'decline' }],
      });
      expect(restore.status).toBe(200);
      await request(app).put('/v1/admin/settings/labor_only_cooldown_days').set(as(U.admin)).send({ value: 90 });
      const log = await pool.query('SELECT policy FROM technician_labor_only_declarations WHERE technician_id = $1 AND category_id = $2 ORDER BY id', [id.tech, plumbing]);
      expect(log.rows.map((r) => r.policy)).toEqual(['accept']);
    });

    it('only matches technicians who are working at the job time', async () => {
      await request(app).post('/v1/technicians/me/time-off').set(as(U.tech2)).send({ startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString() });
      const r = await request(app).post('/v1/jobs').set(as(U.cust)).send({ categoryId: plumbing, title: 'Now job', address: '2 Now St', ...LAGOS, currency: 'NGN' });
      expect(r.body.matchedTechnicians).toBe(1);
      expect(scheduler.notifications.map((n) => n.userId)).toEqual([id.tech]);
      await request(app).post(`/v1/jobs/${r.body.job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
      const off = (await request(app).get('/v1/technicians/me/availability').set(as(U.tech2))).body.timeOff[0];
      await request(app).delete(`/v1/technicians/me/time-off/${off.id}`).set(as(U.tech2));
    });
  });

  // ------------------------------------------------------------------ Section 4 requests
  describe('accepting and declining job requests', () => {
    it('accepts, or declines a booking request which releases the job', async () => {
      const job = await postJob({ bookingMode: 'request', technicianId: id.tech });
      expect((await request(app).post(`/v1/jobs/${job.id}/request/accept`).set(as(U.tech2))).status).toBe(409);
      const acc = await request(app).post(`/v1/jobs/${job.id}/request/accept`).set(as(U.tech));
      expect(acc.body.job.request_accepted_at).toBeTruthy();
      expect(scheduler.notifications.at(-1)!.userId).toBe(id.cust);

      const job2 = await postJob({ bookingMode: 'request', technicianId: id.tech });
      scheduler.reset();
      expect((await request(app).post(`/v1/jobs/${job2.id}/request/decline`).set(as(U.tech)).send({ reason: 'Fully booked' })).status).toBe(200);
      expect(scheduler.notifications.map((n) => n.userId)).toEqual(expect.arrayContaining([id.tech2, id.cust]));
      expect(scheduler.notifications.map((n) => n.userId)).not.toContain(id.tech);
      const feed = await request(app).get('/v1/jobs?feed=nearby').set(as(U.tech));
      expect(feed.body.jobs.map((j: { id: string }) => j.id)).not.toContain(job2.id);
      const audit = await request(app).get(`/v1/jobs/${job2.id}/audit`).set(as(U.cust));
      expect(audit.body.entries.map((e: { action: string }) => e.action)).toContain('request.declined');
      for (const j of [job, job2]) await request(app).post(`/v1/jobs/${j.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });

    it('declining an instant booking returns the job to the marketplace', async () => {
      await request(app).put('/v1/technicians/me').set(as(U.tech)).send({ instantBookEnabled: true });
      const job = await postJob({ bookingMode: 'instant', technicianId: id.tech });
      const r = await request(app).post(`/v1/jobs/${job.id}/instant/decline`).set(as(U.tech)).send({ reason: 'Emergency' });
      expect(r.status).toBe(200);
      expect(r.body.job).toMatchObject({ status: 'open', technician_id: null, booking_mode: 'open' });
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });

    it('lets technicians dismiss jobs from their feed', async () => {
      const job = await postJob();
      expect((await request(app).post(`/v1/jobs/${job.id}/dismiss`).set(as(U.tech2))).status).toBe(204);
      const feed = await request(app).get('/v1/jobs?feed=nearby').set(as(U.tech2));
      expect(feed.body.jobs.map((j: { id: string }) => j.id)).not.toContain(job.id);
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ Section 5 pricing
  describe('pricing model', () => {
    it('requires a labor line and disclosed part markup within the cap', async () => {
      const job = await postJob();
      expect((await quote(job.id, [part('Heater element', 1_000_000, 1000)])).status).toBe(400); // no labor line
      const over = await quote(job.id, [labor(500_000), part('Heater element', 1_000_000, 2500)]);
      expect(over.status).toBe(422);
      expect(over.body.error).toMatchObject({ code: 'markup_cap_exceeded', details: { capBps: 2000, lines: ['Heater element'] } });

      const ok = await quote(job.id, [labor(500_000), part('Heater element', 6_000_000, 2000), part('Tape', 20_000, 0)]);
      expect(ok.status).toBe(201);
      expect(ok.body.quote).toMatchObject({ amount_minor: 7_720_000, labor_minor: 500_000, parts_base_minor: 6_020_000, markup_minor: 1_200_000, materials_minor: 7_220_000 });
      const d = await request(app).get(`/v1/jobs/${job.id}`).set(as(U.cust));
      expect(d.body.quotes[0].items[1]).toMatchObject({ kind: 'material', base_minor: 6_000_000, markup_bps: 2000, markup_minor: 1_200_000, total_minor: 7_200_000 });
      id.pricedJob = job.id;
      id.pricedQuote = ok.body.quote.id;
    });

    it('needs receipts for parts over the threshold before the job can be completed', async () => {
      await request(app).post(`/v1/jobs/${id.pricedJob}/quotes/${id.pricedQuote}/accept`).set(as(U.cust));
      for (const s of ['en_route', 'in_progress']) await request(app).post(`/v1/jobs/${id.pricedJob}/status`).set(as(U.tech)).send({ status: s });
      const blocked = await request(app).post(`/v1/jobs/${id.pricedJob}/status`).set(as(U.tech)).send({ status: 'completed' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: 'receipts_required', details: { lines: [{ description: 'Heater element', baseMinor: 6_000_000 }] } }); // ₦60k part needs one, ₦200 tape doesn't

      const inv = (await request(app).get(`/v1/jobs/${id.pricedJob}/invoice`).set(as(U.tech))).body.invoice;
      const receipt = await fileFor(id.tech, 'receipt');
      const r = await request(app).post(`/v1/jobs/${id.pricedJob}/quotes/${id.pricedQuote}/items/${inv.parts[0].id}/receipt`).set(as(U.tech)).send({ fileId: receipt });
      expect(r.status).toBe(200);
      expect((await request(app).post(`/v1/jobs/${id.pricedJob}/status`).set(as(U.tech)).send({ status: 'completed' })).status).toBe(200);
    });

    it('charges 18% on labor and 20% on markup, nothing on base part cost', async () => {
      const tech = (await request(app).get(`/v1/jobs/${id.pricedJob}/invoice`).set(as(U.tech))).body.invoice;
      expect(tech.totals).toEqual({ labor: 500_000, partsBase: 6_020_000, markup: 1_200_000, materials: 7_220_000, total: 7_720_000 });
      expect(tech.commission).toMatchObject({ laborBps: 1800, markupBps: 2000, laborFee: 90_000, markupFee: 240_000, platformFee: 330_000, technicianPayout: 7_390_000 });
      const cust = (await request(app).get(`/v1/jobs/${id.pricedJob}/invoice`).set(as(U.cust))).body.invoice;
      expect(cust.commission).toBeUndefined();
      expect(cust.parts[0]).toMatchObject({ baseMinor: 6_000_000, markupBps: 2000, markupMinor: 1_200_000, receiptRequired: true });

      const pay = await request(app).post(`/v1/jobs/${id.pricedJob}/payments`).set(as(U.cust)).send({ method: 'card' });
      expect(pay.body).toMatchObject({ amountMinor: 7_720_000, platformFeeMinor: 330_000, settlement: 'platform_collect' });
      const raw = JSON.stringify({ id: 'evt_priced', type: 'payment.succeeded', reference: pay.body.paymentId, amount: 7_720_000 });
      await request(app).post('/v1/webhooks/payments/mock').set('x-mock-signature', MockProvider.sign(raw)).set('Content-Type', 'application/json').send(raw);
      const w = await request(app).get('/v1/wallet').set(as(U.tech));
      expect(w.body.balances[0].balance_minor).toBe(7_390_000);
    });

    it('snapshots commission rates on the job when the quote is accepted', async () => {
      await reviewAll();
      await request(app).put('/v1/admin/settings/commission').set(as(U.admin)).send({ value: { laborBps: 1000, markupBps: 1000 } });
      const bad = await request(app).put('/v1/admin/settings/commission').set(as(U.admin)).send({ value: { laborBps: 20_000 } });
      expect(bad.status).toBe(400);
      expect((await request(app).get(`/v1/jobs/${id.pricedJob}/invoice`).set(as(U.tech))).body.invoice.commission.laborBps).toBe(1800);
      const job = await postJob();
      const q = (await quote(job.id, [labor(1_000_000)])).body.quote;
      await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/accept`).set(as(U.cust));
      expect((await request(app).get(`/v1/jobs/${job.id}/invoice`).set(as(U.tech))).body.invoice.commission).toMatchObject({ laborBps: 1000, platformFee: 100_000 });
      await request(app).put('/v1/admin/settings/commission').set(as(U.admin)).send({ value: { laborBps: 1800, markupBps: 2000 } });
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });

    it('a price challenge never eats into the base cost of parts', async () => {
      const job = await postJob();
      const q = (await quote(job.id, [labor(200_000), part('Valve', 1_000_000, 1000)])).body.quote; // total 1.3m
      const c = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counter`).set(as(U.cust)).send({ kind: 'price_challenge', proposedTotalMinor: 1_050_000, message: 'Market rate' });
      const r = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counters/${c.body.counter.id}/respond`).set(as(U.tech)).send({ decision: 'accept' });
      expect(r.status).toBe(200);
      const inv = (await request(app).get(`/v1/jobs/${job.id}/invoice`).set(as(U.tech))).body.invoice;
      expect(inv.adjustments.map((a: { appliesTo: string; totalMinor: number }) => [a.appliesTo, a.totalMinor])).toEqual([
        ['labor', -200_000],
        ['markup', -50_000],
      ]);
      expect(inv.totals).toMatchObject({ labor: 0, partsBase: 1_000_000, markup: 50_000, total: 1_050_000 });
      expect(inv.commission.platformFee).toBe(10_000); // 20% of the remaining 50k markup
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ Section 5a Demand Notice
  describe('Demand Notice (markup cap exception)', () => {
    it('holds the quote pending an admin decision, then applies an approved markup to that invoice only', async () => {
      const job = await postJob();
      const evidence = await fileFor(id.tech, 'receipt');
      const q = await quote(job.id, [
        labor(300_000),
        part('Imported pump', 2_000_000, 3500, { capException: { reason: 'Only supplier is in Kano; transport and import duty', evidenceFileIds: [evidence] } }),
      ]);
      expect(q.status).toBe(201);
      expect(q.body.quote.status).toBe('pending_exception');
      expect(scheduler.notifications.map((n) => n.userId)).toEqual(expect.arrayContaining([id.cust, id.admin]));

      // Customer can neither approve nor counter while under review.
      expect((await request(app).post(`/v1/jobs/${job.id}/quotes/${q.body.quote.id}/accept`).set(as(U.cust))).status).toBe(409);
      expect((await request(app).post(`/v1/jobs/${job.id}/quotes/${q.body.quote.id}/counter`).set(as(U.cust)).send({ kind: 'labor_negotiation', proposedLaborMinor: 100_000 })).status).toBe(409);

      const cases = await request(app).get('/v1/admin/cap-exceptions').set(as(U.admin));
      const c = cases.body.cases.find((x: { job_id: string }) => x.job_id === job.id);
      expect(c).toMatchObject({ requested_markup_bps: 3500, cap_bps: 2000, base_minor: 2_000_000, line_description: 'Imported pump' });
      expect(c.evidence).toHaveLength(1);

      const d = await request(app).post(`/v1/admin/cap-exceptions/${c.id}/decide`).set(as(U.admin)).send({ decision: 'approve', note: 'Supplier invoice checks out' });
      expect(d.body).toEqual({ status: 'approved', quoteReleased: true });
      const detail = await request(app).get(`/v1/jobs/${job.id}`).set(as(U.cust));
      expect(detail.body.quotes[0]).toMatchObject({ status: 'pending', markup_minor: 700_000 });
      expect(detail.body.quotes[0].cap_exceptions[0]).toMatchObject({ status: 'approved', admin_note: 'Supplier invoice checks out' });

      const audit = await request(app).get(`/v1/jobs/${job.id}/audit`).set(as(U.cust));
      const actions = audit.body.entries.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['cap_exception.requested', 'cap_exception.approved']));
      expect(audit.body.entries.find((e: { action: string }) => e.action === 'cap_exception.requested').details.evidenceFileIds).toEqual([evidence]);

      // The approval doesn't carry over: a revision with the same markup needs a fresh request.
      const rev = await request(app).put(`/v1/jobs/${job.id}/quotes/${q.body.quote.id}`).set(as(U.tech)).send({ items: [labor(300_000), part('Imported pump', 2_000_000, 3500)] });
      expect(rev.status).toBe(422);
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });

    it('a declined request reduces the line to the cap', async () => {
      const job = await postJob();
      const evidence = await fileFor(id.tech, 'receipt');
      const q = (await quote(job.id, [labor(300_000), part('Pump', 1_000_000, 4000, { capException: { reason: 'Scarce item this month', evidenceFileIds: [evidence] } })])).body.quote;
      const c = (await request(app).get('/v1/admin/cap-exceptions').set(as(U.admin))).body.cases.find((x: { job_id: string }) => x.job_id === job.id);
      await request(app).post(`/v1/admin/cap-exceptions/${c.id}/decide`).set(as(U.admin)).send({ decision: 'decline', note: 'Price proof does not support 40%' });
      const detail = await request(app).get(`/v1/jobs/${job.id}`).set(as(U.cust));
      expect(detail.body.quotes[0]).toMatchObject({ id: q.id, status: 'pending', markup_minor: 200_000, amount_minor: 1_500_000 });
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });

    it('a permanent per-technician override raises their cap without a Demand Notice', async () => {
      await request(app).put(`/v1/admin/technicians/${id.tech2}/markup-cap`).set(as(U.admin)).send({ capBps: 3000 });
      const job = await postJob();
      const ok = await quote(job.id, [labor(100_000), part('Rare fitting', 100_000, 3000)], U.tech2);
      expect(ok.body.quote.status).toBe('pending');
      expect((await quote(job.id, [labor(100_000), part('Rare fitting', 100_000, 3000)], U.tech)).status).toBe(422);
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ earnings, promotions, payouts
  describe('earnings dashboard, promotions and payouts', () => {
    it('shows earnings split and the performance multiplier with next-tier guidance', async () => {
      const r = await request(app).get('/v1/technicians/me/earnings').set(as(U.tech));
      expect(r.body.earnings[0]).toMatchObject({ currency: 'NGN', jobs_paid: 1, gross_minor: 7_720_000, commission_minor: 330_000, net_minor: 7_390_000, labor_minor: 500_000, parts_reimbursed_minor: 6_020_000, markup_minor: 1_200_000 });
      expect(r.body.performance.current).toMatchObject({ tier: 'new', multiplier: 1 });
      expect(r.body.performance.actions[0].action).toMatch(/Complete 2 more jobs/);
      expect(r.body.performance.tiers.map((t: { tier: string }) => t.tier)).toEqual(['standard', 'trusted', 'elite']);
    });

    it('sells boosts and priority alerts to eligible technicians, paid from the wallet', async () => {
      const unverified = await register('tech3', '+2348100000005', { role: 'technician', fullName: 'New Tech' });
      const nope = await request(app).get('/v1/technicians/me/promotions').set(as('tech3'));
      expect(nope.body.eligibility).toEqual({ eligible: false, reasons: ['Your account must be verified'] });
      expect(unverified).toBeTruthy();

      const opts = await request(app).get('/v1/technicians/me/promotions?currency=NGN').set(as(U.tech));
      expect(opts.body.eligibility.eligible).toBe(true);
      expect(opts.body.products.map((p: { key: string }) => p.key)).toEqual(['boost_7d', 'boost_30d', 'alerts_30d']);

      const boost = await request(app).post('/v1/technicians/me/promotions').set(as(U.tech)).send({ product: 'boost_7d', categoryId: plumbing });
      expect(boost.status).toBe(201);
      const again = await request(app).post('/v1/technicians/me/promotions').set(as(U.tech)).send({ product: 'boost_7d', categoryId: plumbing });
      expect(new Date(again.body.purchase.startsAt).getTime()).toBe(new Date(boost.body.purchase.endsAt).getTime()); // extends
      const alerts = await request(app).post('/v1/technicians/me/promotions').set(as(U.tech)).send({ product: 'alerts_30d' });
      expect(alerts.status).toBe(201);
      expect((await request(app).get('/v1/wallet').set(as(U.tech))).body.balances[0].balance_minor).toBe(7_390_000 - 500_000 - 500_000 - 300_000);

      const disc = await request(app).get(`/v1/discover?categoryId=${plumbing}`).set(as(U.cust));
      expect(disc.body.boosted.map((c: { id: string }) => c.id)).toEqual([id.tech]);

      // Priority alerts double the technician's reach: a job ~18 km away (outside the 15 km match radius) still reaches them.
      await reviewAll();
      scheduler.reset();
      const far = await request(app).post('/v1/jobs').set(as(U.cust)).send({ categoryId: plumbing, title: 'Far job', address: 'Far Rd', lat: 6.45, lng: 3.4, currency: 'NGN' });
      expect(scheduler.notifications.map((n) => n.userId)).toContain(id.tech);
      expect(scheduler.notifications.map((n) => n.userId)).not.toContain(id.tech2);
      await request(app).post(`/v1/jobs/${far.body.job.id}/status`).set(as(U.cust)).send({ status: 'cancelled' });
    });

    it('pays out standard (free, next batch) or instant (fee), refunding the wallet on failure', async () => {
      expect((await request(app).post('/v1/technicians/me/payouts').set(as(U.tech)).send({ amountMinor: 100_000, currency: 'NGN', speed: 'standard' })).body.error.message).toMatch(/Set up payouts/);
      await request(app).post('/v1/technicians/me/payout-account').set(as(U.tech)).send({ currency: 'NGN', country: 'NG', bank: { bankCode: '058', accountNumber: '0123456789' } });

      const q = await request(app).get('/v1/technicians/me/payouts/quote?amountMinor=100000&currency=NGN&speed=instant').set(as(U.tech));
      expect(q.body).toMatchObject({ feeMinor: 10_000, netMinor: 90_000 }); // min fee ₦100 beats 1.5%

      const std = await request(app).post('/v1/technicians/me/payouts').set(as(U.tech)).send({ amountMinor: 100_000, currency: 'NGN', speed: 'standard' });
      expect(std.body.payout).toMatchObject({ fee_minor: 0, net_minor: 100_000, status: 'requested' });
      expect(scheduler.payouts[0]!.delayMs).toBeGreaterThan(0);
      expect(await processPayout(std.body.payout.id)).toBe('sent');

      const inst = await request(app).post('/v1/technicians/me/payouts').set(as(U.tech)).send({ amountMinor: 100_000, currency: 'NGN', speed: 'instant' });
      expect(inst.body.payout).toMatchObject({ fee_minor: 10_000, net_minor: 90_000 });
      expect(scheduler.payouts[1]!.delayMs).toBe(0);
      const before = (await request(app).get('/v1/wallet').set(as(U.tech))).body.balances[0].balance_minor;

      await pool.query(`UPDATE technician_profiles SET payout_account_number = 'FAIL' WHERE user_id = $1`, [id.tech]);
      expect(await processPayout(inst.body.payout.id)).toBe('failed');
      const after = (await request(app).get('/v1/wallet').set(as(U.tech))).body.balances[0].balance_minor;
      expect(after - before).toBe(100_000); // amount + fee returned
      const list = await request(app).get('/v1/technicians/me/payouts').set(as(U.tech));
      expect(list.body.payouts.map((p: { status: string }) => p.status)).toEqual(['failed', 'sent']);
    });
  });

  // ------------------------------------------------------------------ customer ratings
  describe('technicians rate customers on agreement compliance', () => {
    it('requires the right categories and shows the result to technicians', async () => {
      const bad = await request(app).post(`/v1/jobs/${id.pricedJob}/customer-rating`).set(as(U.tech)).send({ scores: { payment: 5 } });
      expect(bad.status).toBe(400);
      const ok = await request(app).post(`/v1/jobs/${id.pricedJob}/customer-rating`).set(as(U.tech)).send({ scores: { payment: 5, scope: 4, conduct: 5 }, comment: 'Paid promptly' });
      expect(ok.status).toBe(201);
      expect(ok.body.rating.overall).toBe(4.67);
      const job = await postJob();
      const view = await request(app).get(`/v1/jobs/${job.id}`).set(as(U.tech));
      expect(view.body.customer).toMatchObject({ first_name: 'Ada', rating_avg: 4.67, rating_count: 1 });
      expect((await request(app).get(`/v1/jobs/${job.id}`).set(as(U.cust))).body.customer).toBeUndefined();
    });
  });
});
