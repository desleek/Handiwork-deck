import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { InMemoryScheduler, jobs } from '../src/queues/index';
import { LoggingWhatsAppClient, setWhatsAppClient } from '../src/services/messaging/whatsapp';
import { LoggingEmailClient, setEmailClient } from '../src/services/notifications/email';
import { MockProvider } from '../src/services/payments/providers/mock';
import { processChallengeStep } from '../src/services/priceChallenges';
import { recalcRateAdjustment, runRateCycle } from '../src/services/rateAdjustment';
import { setStorageDriver } from '../src/services/storage/index';
import { bearer, categoryId, dbAvailable, fullScores, resetDb } from './helpers';

const hasDb = await dbAvailable();
const app = createApp();
const scheduler = jobs() as InMemoryScheduler;
const wa = new LoggingWhatsAppClient();
const mail = new LoggingEmailClient();
setWhatsAppClient(wa);
setEmailClient(mail);
setStorageDriver({
  createUploadTicket: async ({ kind }) => ({ driver: 's3', storageKey: `${kind}/k`, uploadUrl: 'https://upload.example', method: 'PUT', publicUrl: 'https://cdn.example/f' }),
});

const as = (uid: string) => ({ Authorization: bearer(uid) });
const LAGOS = { lat: 6.6018, lng: 3.3515 };
const id: { [k: string]: string } = {};
let plumbing: number;
const HOUR = 3_600_000;

async function register(uid: string, phone: string, body: Record<string, unknown>) {
  const r = await request(app).post('/v1/auth/register').set('Authorization', bearer(uid, phone)).send(body);
  expect(r.status).toBe(201);
  return r.body.user.id as string;
}
const labor = (amount: number) => ({ kind: 'labor', description: 'Labor', quantity: 1, unitPriceMinor: amount });
const part = (description: string, base: number, markupBps = 1000) => ({ kind: 'material', description, quantity: 1, unitPriceMinor: base, markupBps });

async function postJob(cust = 'cust', extra: Record<string, unknown> = {}) {
  const r = await request(app).post('/v1/jobs').set(as(cust)).send({ categoryId: plumbing, title: 'Replace pump', address: '1 Test St', ...LAGOS, currency: 'NGN', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.job as { id: string; ref: string };
}
async function quote(jobId: string, items: object[], tech = 'tech') {
  const r = await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(tech)).send({ items });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.quote as { id: string; amount_minor: number };
}
/** Posts, quotes, approves, completes and pays a job through the (mock) platform gateway. */
async function paidJob(tech: string, cust: string, amount = 100_000) {
  const job = await postJob(cust);
  const q = await quote(job.id, [labor(amount)], tech);
  await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/accept`).set(as(cust));
  for (const s of ['en_route', 'in_progress', 'completed']) await request(app).post(`/v1/jobs/${job.id}/status`).set(as(tech)).send({ status: s });
  const pay = await request(app).post(`/v1/jobs/${job.id}/payments`).set(as(cust)).send({ method: 'card' });
  const raw = JSON.stringify({ id: `evt_${job.id}`, type: 'payment.succeeded', reference: pay.body.paymentId, amount: pay.body.amountMinor });
  await request(app).post('/v1/webhooks/payments/mock').set('x-mock-signature', MockProvider.sign(raw)).set('Content-Type', 'application/json').send(raw);
  return job.id;
}
async function review(cust: string, jobId: string, n: number) {
  const r = await request(app).post(`/v1/jobs/${jobId}/review`).set(as(cust)).send({ scores: fullScores(n), comment: `Rated ${n} stars overall` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

describe.skipIf(!hasDb)('Sections 6, 7, 7a: quote responses, dual ratings, labor rate adjustment', () => {
  beforeAll(async () => {
    await resetDb();
    plumbing = await categoryId('plumbing');
    id.admin = await register('admin', '+2348200000001', { role: 'customer', fullName: 'Ops Admin', customerType: 'office' });
    await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL, email = 'ops@example.com' WHERE id = $1`, [id.admin]);
    id.cust = await register('cust', '+2348200000002', { role: 'customer', fullName: 'Ada Customer', customerType: 'homeowner', email: 'ada@example.com' });
    id.cust2 = await register('cust2', '+2348200000003', { role: 'customer', fullName: 'Ben Customer', customerType: 'sme', email: 'ben@example.com' });
    for (const [uid, name, policy, phone] of [
      ['tech', 'Tunde Tech', 'accept', '+2348200000010'],
      ['techD', 'Dayo Decline', 'decline', '+2348200000011'],
    ] as const) {
      id[uid] = await register(uid, phone, { role: 'technician', fullName: name, email: `${uid}@example.com` });
      await request(app).put('/v1/technicians/me/services').set(as(uid)).send({ services: [{ categoryId: plumbing, laborOnly: policy, baseRateMinor: 100_000, currency: 'NGN' }] });
      await request(app).put('/v1/technicians/me').set(as(uid)).send({ baseLat: 6.6, baseLng: 3.35, serviceRadiusKm: 20 });
      await request(app).post(`/v1/admin/technicians/${id[uid]}/verification`).set(as('admin')).send({ status: 'verified' });
    }
    // Verified-seller registry (Section 10 placeholder).
    id.seller = (await request(app).post('/v1/admin/sellers').set(as('admin')).send({ name: 'Alaba Pumps Ltd', city: 'Lagos', isVerified: true })).body.seller.id;
    id.shady = (await request(app).post('/v1/admin/sellers').set(as('admin')).send({ name: 'Unverified Parts' })).body.seller.id;
  });
  beforeEach(() => {
    scheduler.reset();
    wa.sent.length = 0;
    mail.sent.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  // ------------------------------------------------------------------ 6b labor-only
  describe('labor-only counters (6b)', () => {
    it('is unavailable where the technician declared "Decline from inception"', async () => {
      const job = await postJob();
      const q = await quote(job.id, [labor(50_000), part('Pump', 200_000)], 'techD');
      const r = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counter`).set(as('cust')).send({ kind: 'labor_only' });
      expect(r.status).toBe(409);
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as('cust')).send({ status: 'cancelled' });
    });

    it('counts rejections where they declared "Accept"; exceeding the cap penalises and flags them', async () => {
      await request(app).put('/v1/admin/settings/labor_only_rejections').set(as('admin')).send({ value: { cap: 3, windowDays: 90, penaltyPoints: 0.5, penaltyDays: 90 } });
      for (let i = 1; i <= 4; i++) {
        const job = await postJob();
        const q = await quote(job.id, [labor(50_000), part('Pump', 200_000)]);
        const c = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counter`).set(as('cust')).send({ kind: 'labor_only', message: 'I have the pump' });
        const r = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counters/${c.body.counter.id}/respond`).set(as('tech')).send({ decision: 'decline' });
        expect(r.status).toBe(200);
        await request(app).post(`/v1/jobs/${job.id}/status`).set(as('cust')).send({ status: 'cancelled' });
      }
      const rej = await pool.query('SELECT penalized FROM labor_only_rejections WHERE technician_id = $1 ORDER BY id', [id.tech]);
      expect(rej.rows.map((r) => r.penalized)).toEqual([false, false, false, true]);
      const flags = await request(app).get('/v1/admin/flags').set(as('admin'));
      expect(flags.body.flags).toEqual([expect.objectContaining({ technician_id: id.tech, kind: 'labor_only_rejections' })]);
      const pen = await pool.query('SELECT points::float8 AS p FROM rating_penalties WHERE technician_id = $1', [id.tech]);
      expect(pen.rows).toEqual([{ p: 0.5 }]);
    });

    it('switching the declaration keeps prior rejections and is limited by a 30-day cooldown', async () => {
      const r = await request(app).put(`/v1/technicians/me/services/${plumbing}/labor-only`).set(as('tech')).send({ policy: 'decline' });
      expect(r.status).toBe(409);
      expect(new Date(r.body.error.details.nextChangeAllowedAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
      await pool.query(`UPDATE technician_labor_only_declarations SET declared_at = now() - interval '31 days' WHERE technician_id = $1`, [id.tech]);
      expect((await request(app).put(`/v1/technicians/me/services/${plumbing}/labor-only`).set(as('tech')).send({ policy: 'decline' })).status).toBe(200);
      expect((await pool.query('SELECT count(*)::int AS n FROM labor_only_rejections WHERE technician_id = $1', [id.tech])).rows[0].n).toBe(4);
      const profile = await request(app).get(`/v1/technicians/${id.tech}`).set(as('cust'));
      expect(profile.body.technician.services[0]).toMatchObject({ labor_only_policy: 'decline' });
      expect(profile.body.technician.services[0].labor_only_declared_at).toBeTruthy();
      // Back to "accept" for the rest of the suite.
      await pool.query(`UPDATE technician_labor_only_declarations SET declared_at = now() - interval '31 days' WHERE technician_id = $1`, [id.tech]);
      await request(app).put(`/v1/technicians/me/services/${plumbing}/labor-only`).set(as('tech')).send({ policy: 'accept' });
    });
  });

  // ------------------------------------------------------------------ 6c price challenges
  describe('parts price challenge (6c)', () => {
    let jobId: string;
    let quoteId: string;
    let pumpId: string;
    let evidence: string;

    it('rejects evidence from sellers outside the verified registry at upload', async () => {
      const bad = await request(app).post('/v1/uploads').set(as('cust')).send({ kind: 'price_evidence', contentType: 'image/jpeg', sellerId: id.shady });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('unverifiable_evidence');
      expect((await request(app).post('/v1/uploads').set(as('cust')).send({ kind: 'price_evidence', contentType: 'image/jpeg' })).status).toBe(422);
      const ok = await request(app).post('/v1/uploads').set(as('cust')).send({ kind: 'price_evidence', contentType: 'image/jpeg', sellerId: id.seller });
      expect(ok.status).toBe(201);
      evidence = ok.body.fileId;
      const sellers = await request(app).get('/v1/sellers').set(as('cust'));
      expect(sellers.body.sellers.map((s: { name: string }) => s.name)).toEqual(['Alaba Pumps Ltd']);
    });

    it('schedules the standard timeline and lets the technician match the evidenced price', async () => {
      const job = await postJob();
      jobId = job.id;
      const q = await quote(job.id, [labor(50_000), part('Pump', 300_000, 2000), part('Tape', 5_000, 0)]);
      quoteId = q.id;
      const detail = await request(app).get(`/v1/jobs/${job.id}`).set(as('cust'));
      pumpId = detail.body.quotes[0].items.find((i: { description: string }) => i.description === 'Pump').id;
      const laborId = detail.body.quotes[0].items.find((i: { kind: string }) => i.kind === 'labor').id;

      const onLabor = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: laborId, proposedUnitPriceMinor: 1 }], evidenceFileIds: [evidence] });
      expect(onLabor.status).toBe(400);

      const c = await request(app)
        .post(`/v1/jobs/${job.id}/quotes/${q.id}/price-challenges`)
        .set(as('cust'))
        .send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 250_000 }], evidenceFileIds: [evidence], message: 'Alaba sells it for ₦2,500' });
      expect(c.status).toBe(201);
      const hours = scheduler.challengeSteps.map((s) => [s.data.step, s.delayMs / HOUR]);
      expect(hours).toEqual([
        ['reminder', 6], ['reminder', 10], ['reminder', 14], ['reminder', 18], ['reminder', 22], ['reminder', 26], ['reminder', 30],
        ['escalate', 48], ['final', 72],
      ]);
      expect(scheduler.notifications.at(-1)).toMatchObject({ userId: id.tech, message: { title: 'Parts price challenge' } });
      // While open the customer can't approve.
      expect((await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/accept`).set(as('cust'))).status).toBe(409);

      const m = await request(app).post(`/v1/price-challenges/${c.body.challenge.id}/respond`).set(as('tech')).send({ response: 'match' });
      expect(m.status).toBe(200);
      const after = await request(app).get(`/v1/jobs/${job.id}`).set(as('cust'));
      const pump = after.body.quotes[0].items.find((i: { id: string }) => i.id === pumpId);
      expect(pump).toMatchObject({ unit_price_minor: 250_000, base_minor: 250_000, markup_bps: 2000, markup_minor: 50_000 });
      expect(after.body.quotes[0].status).toBe('pending');
      // Scheduled steps become no-ops once answered.
      expect(await processChallengeStep({ challengeId: c.body.challenge.id, step: 'final' })).toBe('skipped');
    });

    it('explain needs a message; hold firm leaves prices unchanged', async () => {
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${quoteId}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 200_000 }], evidenceFileIds: [evidence] });
      expect((await request(app).post(`/v1/price-challenges/${c.body.challenge.id}/respond`).set(as('tech')).send({ response: 'explain' })).status).toBe(400);
      expect((await request(app).post(`/v1/price-challenges/${c.body.challenge.id}/respond`).set(as('tech')).send({ response: 'hold_firm' })).status).toBe(200);
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as('cust'));
      expect(d.body.quotes[0].items.find((i: { id: string }) => i.id === pumpId).unit_price_minor).toBe(250_000);
      const list = await request(app).get(`/v1/jobs/${jobId}/price-challenges`).set(as('cust'));
      expect(list.body.challenges.map((x: { status: string }) => x.status)).toEqual(['held_firm', 'matched']);
      expect(list.body.challenges[0].evidence[0]).toMatchObject({ seller: 'Alaba Pumps Ltd' });
    });

    it('unanswered: reminders, then admin + email + WhatsApp, then auto-approval', async () => {
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${quoteId}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 200_000 }], evidenceFileIds: [evidence] });
      const cid = c.body.challenge.id;
      scheduler.reset();
      expect(await processChallengeStep({ challengeId: cid, step: 'reminder', n: 1 })).toBe('reminded');
      expect(scheduler.notifications[0]).toMatchObject({ userId: id.tech, message: { title: 'Price challenge waiting' } });
      expect(await processChallengeStep({ challengeId: cid, step: 'escalate' })).toBe('escalated');
      expect(mail.sent).toEqual([expect.objectContaining({ to: 'tech@example.com', subject: expect.stringContaining('price challenge') })]);
      expect(wa.sent.at(-1)!.body).toContain('[template:price_challenge_escalation]');
      expect(scheduler.notifications.map((n) => n.userId)).toContain(id.admin);
      const queue = await request(app).get('/v1/admin/price-challenges').set(as('admin'));
      expect(queue.body.challenges[0]).toMatchObject({ id: cid, fast_track: false });
      expect(queue.body.challenges[0].escalated_at).toBeTruthy();

      expect(await processChallengeStep({ challengeId: cid, step: 'final' })).toBe('auto_approve');
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as('cust'));
      expect(d.body.quotes[0].items.find((i: { id: string }) => i.id === pumpId).unit_price_minor).toBe(200_000);
      const audit = await request(app).get(`/v1/jobs/${jobId}/audit`).set(as('cust'));
      expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(
        expect.arrayContaining(['price_challenge.submitted', 'price_challenge.escalated', 'price_challenge.auto_approved']),
      );
    });

    it('fast track compresses the timeline, is flagged urgent, and sorts first for admins; global switch to auto-cancel', async () => {
      await request(app).put('/v1/admin/settings/price_challenge').set(as('admin')).send({
        value: {
          timeoutAction: 'cancel_redirect_labor_only',
          standard: { responseDueHours: 6, remindersUntilHours: 30, reminderEveryHours: 4, adminEscalationHours: 48, finalActionHours: 72 },
          fastTrack: { responseDueHours: 2, remindersUntilHours: 8, reminderEveryHours: 1, adminEscalationHours: 8, finalActionHours: 24 },
        },
      });
      const c = await request(app)
        .post(`/v1/jobs/${jobId}/quotes/${quoteId}/price-challenges`)
        .set(as('cust'))
        .send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 150_000 }], evidenceFileIds: [evidence], fastTrack: true });
      expect(c.body.challenge.fast_track).toBe(true);
      expect(scheduler.challengeSteps.map((s) => s.delayMs / HOUR)).toEqual([2, 3, 4, 5, 6, 7, 8, 8, 24]);
      expect(scheduler.notifications.at(-1)!.message.title).toBe('URGENT: parts price challenge');

      expect(await processChallengeStep({ challengeId: c.body.challenge.id, step: 'final' })).toBe('cancel_redirect_labor_only');
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as('cust'));
      expect(d.body.quotes[0].items.find((i: { id: string }) => i.id === pumpId).unit_price_minor).toBe(200_000); // unchanged
      expect(scheduler.notifications.at(-1)).toMatchObject({ userId: id.cust, message: { data: { redirect: 'labor_only' } } });
      await request(app).put('/v1/admin/settings/price_challenge').set(as('admin')).send({
        value: {
          timeoutAction: 'auto_approve',
          standard: { responseDueHours: 6, remindersUntilHours: 30, reminderEveryHours: 4, adminEscalationHours: 48, finalActionHours: 72 },
          fastTrack: { responseDueHours: 2, remindersUntilHours: 8, reminderEveryHours: 1, adminEscalationHours: 8, finalActionHours: 24 },
        },
      });
    });

    it('admins can resolve a challenge either way', async () => {
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${quoteId}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 100_000 }], evidenceFileIds: [evidence] });
      const r = await request(app).post(`/v1/admin/price-challenges/${c.body.challenge.id}/resolve`).set(as('admin')).send({ decision: 'uphold_technician', note: 'Different pump model' });
      expect(r.status).toBe(200);
      const list = await request(app).get(`/v1/jobs/${jobId}/price-challenges`).set(as('cust'));
      expect(list.body.challenges[0]).toMatchObject({ status: 'admin_upheld', resolution_note: 'Different pump model' });
      await request(app).post(`/v1/jobs/${jobId}/status`).set(as('cust')).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ 6d labor negotiation
  describe('labor cost negotiation (6d)', () => {
    it('technician counters; customer accepts; job-only rate, standard rate untouched, all logged', async () => {
      const job = await postJob();
      const q = await quote(job.id, [labor(100_000), part('Valve', 50_000)]);
      const c = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counter`).set(as('cust')).send({ kind: 'labor_negotiation', proposedLaborMinor: 70_000 });
      // The customer can't answer their own proposal; the technician can't counter outside the range.
      expect((await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counters/${c.body.counter.id}/respond`).set(as('cust')).send({ decision: 'accept' })).status).toBe(409);
      expect(
        (await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counters/${c.body.counter.id}/respond`).set(as('tech')).send({ decision: 'counter', proposedLaborMinor: 60_000 })).status,
      ).toBe(409);
      const tc = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counters/${c.body.counter.id}/respond`).set(as('tech')).send({ decision: 'counter', proposedLaborMinor: 85_000, message: 'Can do 85k' });
      expect(tc.body.event).toBe('countered');
      const d = await request(app).get(`/v1/jobs/${job.id}`).set(as('cust'));
      const open = d.body.quotes[0].latest_counter;
      expect(open).toMatchObject({ proposed_labor_minor: 85_000, status: 'pending' });
      const acc = await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/counters/${open.id}/respond`).set(as('cust')).send({ decision: 'accept' });
      expect(acc.body.job).toMatchObject({ status: 'assigned', budget_minor: 85_000 + 55_000 });

      const profile = await request(app).get(`/v1/technicians/${id.tech}`).set(as('cust2'));
      expect(profile.body.technician.services[0].base_rate_minor).toBe(100_000);
      const audit = await request(app).get(`/v1/jobs/${job.id}/audit`).set(as('cust'));
      const actions = audit.body.entries.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['counter.sent', 'labor.countered', 'counter.accepted']));
      expect(audit.body.entries.find((e: { action: string }) => e.action === 'labor.countered').details).toMatchObject({ customerProposedLaborMinor: 70_000, technicianLaborMinor: 85_000, standardLaborMinor: 100_000 });
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as('cust')).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ 7 dual ratings
  describe('dual ratings and completion badge (7)', () => {
    it('reviews and customer ratings need a platform-paid booking; three paid jobs earn the badge', async () => {
      const job = await postJob('cust2');
      const q = await quote(job.id, [labor(50_000)], 'techD');
      await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/accept`).set(as('cust2'));
      for (const s of ['en_route', 'in_progress', 'completed']) await request(app).post(`/v1/jobs/${job.id}/status`).set(as('techD')).send({ status: s });
      expect((await request(app).post(`/v1/jobs/${job.id}/review`).set(as('cust2')).send({ scores: fullScores(5), comment: 'Good, not paid yet' })).status).toBe(409);
      expect((await request(app).post(`/v1/jobs/${job.id}/customer-rating`).set(as('techD')).send({ scores: { on_site: 5, access: 5, paid_on_platform: 5, conduct: 5 } })).status).toBe(409);
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as('cust2')).send({ status: 'disputed' });

      for (let i = 0; i < 3; i++) {
        const j = await paidJob('techD', 'cust2');
        await review('cust2', j, 5);
        expect((await request(app).post(`/v1/jobs/${j}/customer-rating`).set(as('techD')).send({ scores: { on_site: 5, access: 5, paid_on_platform: 5, conduct: 4 } })).status).toBe(201);
      }
      const me = await request(app).get('/v1/me').set(as('cust2'));
      // 3 paid of 4 engaged (one disputed) = 75% < 90%: no badge yet.
      expect(me.body.user.trust).toMatchObject({ paidJobs: 3, completionBadge: false, ratingAvg: 4.75 });
      const j4 = await paidJob('techD', 'cust2');
      await review('cust2', j4, 5);
      const j5 = await paidJob('techD', 'cust2');
      await review('cust2', j5, 5);
      // Still below 90% with the dispute on record (5 paid - 1 disputed) / 6 engaged.
      expect((await request(app).get('/v1/me').set(as('cust2'))).body.user.trust.completionBadge).toBe(false);
      await pool.query(`UPDATE jobs SET status = 'cancelled' WHERE customer_id = $1 AND status = 'disputed'`, [id.cust2]);
      expect((await request(app).get('/v1/me').set(as('cust2'))).body.user.trust.completionBadge).toBe(true);

      // Visible to technicians before they accept.
      const next = await postJob('cust2');
      const feed = await request(app).get('/v1/jobs?feed=nearby').set(as('tech'));
      expect(feed.body.jobs.find((j: { id: string }) => j.id === next.id).customer).toMatchObject({ completionBadge: true, ratingCount: 3 });
      await request(app).post(`/v1/jobs/${next.id}/status`).set(as('cust2')).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ 7a labor rate adjustment
  describe('performance-based labor rate adjustment (7a)', () => {
    it('applies the tier on the cycle, to labor only, for future quotes only', async () => {
      // techD has five 5★ reviews from the previous test.
      const before = await postJob('cust');
      const oldQuote = await quote(before.id, [labor(100_000), part('Seal', 10_000)], 'techD');
      expect(oldQuote.amount_minor).toBe(111_000);

      expect(await recalcRateAdjustment(id.techD!)).toBe('applied');
      const earn = await request(app).get('/v1/technicians/me/earnings').set(as('techD'));
      expect(earn.body.performance).toMatchObject({ current: { multiplier: 1.1, tierStars: 5, adjustmentBps: 1000 }, cycleDays: 14 });
      expect(earn.body.performance.nextRecalculationAt).toBeTruthy();

      const job = await postJob('cust');
      const q = await request(app).post(`/v1/jobs/${job.id}/quotes`).set(as('techD')).send({ items: [labor(100_000), part('Seal', 10_000)] });
      expect(q.body.quote).toMatchObject({ amount_minor: 121_000, labor_minor: 110_000, performance_adjustment_bps: 1000 });
      const inv = await request(app).get(`/v1/jobs/${job.id}`).set(as('cust'));
      expect(inv.body.quotes[0].items.find((i: { kind: string }) => i.kind === 'adjustment')).toMatchObject({ description: 'Performance rate adjustment (+10%)', applies_to: 'labor', total_minor: 10_000 });

      // The quote submitted before the recalculation keeps its original rate, even when revised.
      const rev = await request(app).put(`/v1/jobs/${before.id}/quotes/${oldQuote.id}`).set(as('techD')).send({ items: [labor(100_000), part('Seal', 10_000)] });
      expect(rev.body.quote).toMatchObject({ amount_minor: 111_000, performance_adjustment_bps: 0 });

      const disc = await request(app).get(`/v1/discover?categoryId=${plumbing}`).set(as('cust'));
      const card = [...disc.body.boosted, ...disc.body.organic].find((c: { id: string }) => c.id === id.techD);
      expect(card.startingPrice.amountMinor).toBe(110_000);
      expect(card.performance).toMatchObject({ multiplier: 1.1, tierStars: 5 });
      for (const j of [before, job]) await request(app).post(`/v1/jobs/${j.id}/status`).set(as('cust')).send({ status: 'cancelled' });
    });

    it('holds a tier drop caused by one bad review for admin review', async () => {
      // One 1★ on top of five 5★ drops the rolling rating below 4.5 (→ 4★), but without it they'd stay 5★.
      const j = await paidJob('techD', 'cust');
      await review('cust', j, 1);
      expect(await recalcRateAdjustment(id.techD!)).toBe('held');
      const held = await request(app).get('/v1/admin/rate-adjustments').set(as('admin'));
      expect(held.body.adjustments[0]).toMatchObject({ technician_id: id.techD, previous_stars: 5, new_stars: 4, status: 'held' });
      expect((await pool.query('SELECT rate_adjustment_bps FROM technician_profiles WHERE user_id = $1', [id.techD])).rows[0].rate_adjustment_bps).toBe(1000);
      // Held technicians are skipped by the cycle until an admin decides.
      expect(await recalcRateAdjustment(id.techD!)).toBe('skipped');
      await request(app).post(`/v1/admin/rate-adjustments/${held.body.adjustments[0].id}/decide`).set(as('admin')).send({ decision: 'reject', note: 'Outlier review' });
      const p = (await pool.query('SELECT rate_adjustment_bps, rate_held_for_review FROM technician_profiles WHERE user_id = $1', [id.techD])).rows[0];
      expect(p).toEqual({ rate_adjustment_bps: 1000, rate_held_for_review: false });
    });

    it('admins can manually flag a swing, override the rate, and the cycle only picks up due technicians', async () => {
      // Manually flag techD's earlier (applied) 5★ adjustment: it reverts to the previous tier and is held.
      const applied = await request(app).get('/v1/admin/rate-adjustments?status=applied').set(as('admin'));
      const adj = applied.body.adjustments.find((a: { technician_id: string }) => a.technician_id === id.techD);
      expect(adj).toMatchObject({ previous_bps: 0, new_bps: 1000 });
      expect((await request(app).post(`/v1/admin/rate-adjustments/${adj.id}/flag`).set(as('admin')).send({ note: 'Check this' })).status).toBe(200);
      let p = (await pool.query('SELECT rate_adjustment_bps, rate_held_for_review FROM technician_profiles WHERE user_id = $1', [id.techD])).rows[0];
      expect(p).toEqual({ rate_adjustment_bps: 0, rate_held_for_review: true });
      await request(app).post(`/v1/admin/rate-adjustments/${adj.id}/decide`).set(as('admin')).send({ decision: 'approve' });
      p = (await pool.query('SELECT rate_adjustment_bps, rate_held_for_review FROM technician_profiles WHERE user_id = $1', [id.techD])).rows[0];
      expect(p).toEqual({ rate_adjustment_bps: 1000, rate_held_for_review: false });
      expect((await request(app).get('/v1/admin/flags').set(as('admin'))).body.flags.filter((f: { technician_id: string }) => f.technician_id === id.techD)).toEqual([]);

      // The cycle only recalculates technicians whose last calculation is older than the cycle.
      await pool.query(`UPDATE technician_profiles SET rate_calculated_at = now()`);
      await pool.query(`UPDATE technician_profiles SET rate_calculated_at = now() - interval '15 days' WHERE user_id = $1`, [id.tech]);
      expect(await runRateCycle()).toBe(1);

      await request(app).put(`/v1/admin/technicians/${id.techD}/rate-override`).set(as('admin')).send({ bps: -500 });
      const job = await postJob('cust');
      const q = await quote(job.id, [labor(100_000)], 'techD');
      expect(q.amount_minor).toBe(95_000);
      await request(app).put(`/v1/admin/technicians/${id.techD}/rate-override`).set(as('admin')).send({ bps: null });
      await request(app).post(`/v1/jobs/${job.id}/status`).set(as('cust')).send({ status: 'cancelled' });
    });

    it('the same rolling rating gates boost eligibility', async () => {
      expect((await request(app).get('/v1/technicians/me/promotions').set(as('techD'))).body.eligibility.eligible).toBe(true);
      await request(app).post(`/v1/admin/technicians/${id.techD}/rating-penalties`).set(as('admin')).send({ points: 2, reason: 'Test penalty', days: 30 });
      const e = (await request(app).get('/v1/technicians/me/promotions').set(as('techD'))).body.eligibility;
      expect(e.eligible).toBe(false);
      expect(e.reasons[0]).toMatch(/rolling rating/);
    });
  });
});
