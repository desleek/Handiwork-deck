import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { processEscalation } from '../src/queues/escalations';
import { InMemoryScheduler, jobs } from '../src/queues/index';
import { relayInbound } from '../src/services/messaging/relay';
import { LoggingWhatsAppClient, setWhatsAppClient } from '../src/services/messaging/whatsapp';
import { MockProvider } from '../src/services/payments/providers/mock';
import { bearer, dbAvailable, fullScores, laborQuote, payOnCompletion, resetDb } from './helpers';

const hasDb = await dbAvailable();
if (!hasDb) console.warn('Skipping integration tests: PostgreSQL not reachable (set TEST_DATABASE_URL)');

const app = createApp();
const scheduler = jobs() as InMemoryScheduler;
const wa = new LoggingWhatsAppClient();
setWhatsAppClient(wa);

const CUSTOMER = { uid: 'cust-1', phone: '+2348011111111' };
const TECH = { uid: 'tech-1', phone: '+2348022222222' };
const TECH_FAR = { uid: 'tech-far', phone: '+2348033333333' };
const ADMIN = { uid: 'admin-1' };

// Ikeja, Lagos
const JOB_LOC = { lat: 6.6018, lng: 3.3515 };

async function register(u: { uid: string; phone?: string }, body: Record<string, unknown>) {
  const res = await request(app).post('/v1/auth/register').set('Authorization', bearer(u.uid, u.phone)).send(body);
  expect(res.status).toBe(201);
  return res.body.user as { id: string };
}

describe.skipIf(!hasDb)('marketplace flow', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();
    await payOnCompletion();
    ids.customer = (await register(CUSTOMER, { role: 'customer', fullName: 'Ada Obi', customerType: 'homeowner', email: 'ada@example.com' })).id;
    ids.tech = (await register(TECH, { role: 'technician', fullName: 'Tunde Bello' })).id;
    ids.techFar = (await register(TECH_FAR, { role: 'technician', fullName: 'Kemi Far' })).id;
    ids.admin = (await register(ADMIN, { role: 'customer', fullName: 'Ops Admin', customerType: 'office' })).id;
    await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL WHERE id = $1`, [ids.admin]);
  });

  beforeEach(() => {
    scheduler.reset();
    wa.sent.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects unauthenticated and wrong-role requests', async () => {
    expect((await request(app).get('/v1/me')).status).toBe(401);
    const res = await request(app).post('/v1/jobs').set('Authorization', bearer(TECH.uid)).send({});
    expect(res.status).toBe(403);
    const dup = await request(app).post('/v1/auth/register').set('Authorization', bearer(CUSTOMER.uid)).send({ role: 'customer', fullName: 'X', customerType: 'sme' });
    expect(dup.status).toBe(409);
  });

  it('lets an admin verify technicians who set up services and location', async () => {
    const plumbing = (await request(app).get('/v1/categories')).body.categories.find((c: { slug: string }) => c.slug === 'plumbing');
    ids.plumbing = String(plumbing.id);

    for (const [t, loc] of [
      [TECH, { baseLat: 6.59, baseLng: 3.36, serviceRadiusKm: 15 }],
      [TECH_FAR, { baseLat: 6.43, baseLng: 3.42, serviceRadiusKm: 15 }], // Victoria Island, ~20 km away
    ] as const) {
      expect((await request(app).put('/v1/technicians/me').set('Authorization', bearer(t.uid)).send(loc)).status).toBe(200);
      const svc = await request(app).put('/v1/technicians/me/services').set('Authorization', bearer(t.uid)).send({ services: [{ categoryId: plumbing.id, laborOnly: 'accept' }] });
      expect(svc.status).toBe(200);
    }

    const pending = await request(app).get('/v1/admin/technicians').set('Authorization', bearer(ADMIN.uid));
    expect(pending.body.technicians).toHaveLength(2);
    for (const id of [ids.tech, ids.techFar]) {
      const r = await request(app).post(`/v1/admin/technicians/${id}/verification`).set('Authorization', bearer(ADMIN.uid)).send({ status: 'verified' });
      expect(r.status).toBe(200);
    }
    expect((await request(app).get('/v1/admin/stats').set('Authorization', bearer(CUSTOMER.uid))).status).toBe(403);
  });

  it('matches nearby technicians when a job is posted and schedules an escalation', async () => {
    const res = await request(app)
      .post('/v1/jobs')
      .set('Authorization', bearer(CUSTOMER.uid))
      .send({ categoryId: Number(ids.plumbing), title: 'Leaking kitchen sink', address: '12 Allen Ave, Ikeja', ...JOB_LOC, currency: 'NGN' });
    expect(res.status).toBe(201);
    expect(res.body.job.ref).toMatch(/^HW-[A-Z0-9]{5}$/);
    expect(res.body.matchedTechnicians).toBe(1); // only the nearby technician
    ids.job = res.body.job.id;
    ids.jobRef = res.body.job.ref;
    expect(scheduler.notifications.map((n) => n.userId)).toEqual([ids.tech]);
    expect(scheduler.escalations).toEqual([{ data: { kind: 'no_quote_widen', jobId: ids.job }, delayMs: 15 * 60_000 }]);

    const feed = await request(app).get('/v1/jobs?feed=nearby').set('Authorization', bearer(TECH.uid));
    expect(feed.body.jobs.map((j: { id: string }) => j.id)).toContain(ids.job);
  });

  it('widens the search radius when nobody quotes, then alerts admins', async () => {
    expect(await processEscalation({ kind: 'no_quote_widen', jobId: ids.job! })).toBe('widened');
    // The far technician is notified only after widening.
    expect(scheduler.notifications.map((n) => n.userId)).toEqual([ids.techFar]);
    expect(scheduler.escalations[0]!.data.kind).toBe('no_quote_admin');
    scheduler.reset();

    expect(await processEscalation({ kind: 'no_quote_admin', jobId: ids.job! })).toBe('admin_alerted');
    expect(scheduler.notifications.map((n) => n.userId).sort()).toEqual([ids.admin, ids.customer].sort());
    const esc = await request(app).get('/v1/admin/escalations').set('Authorization', bearer(ADMIN.uid));
    expect(esc.body.escalations).toHaveLength(2);
  });

  it('takes quotes and lets the customer accept one', async () => {
    const q1 = await request(app).post(`/v1/jobs/${ids.job}/quotes`).set('Authorization', bearer(TECH.uid)).send(laborQuote(1_500_000, { etaMinutes: 45 }));
    expect(q1.status).toBe(201);
    const q2 = await request(app).post(`/v1/jobs/${ids.job}/quotes`).set('Authorization', bearer(TECH_FAR.uid)).send(laborQuote(2_000_000));
    expect(q2.status).toBe(201);

    // Escalations become no-ops once quotes arrive.
    expect(await processEscalation({ kind: 'no_quote_admin', jobId: ids.job! })).toBe('skipped');

    const detail = await request(app).get(`/v1/jobs/${ids.job}`).set('Authorization', bearer(CUSTOMER.uid));
    expect(detail.body.job.status).toBe('quoted');
    expect(detail.body.quotes).toHaveLength(2);
    // A technician only sees their own quote.
    const techView = await request(app).get(`/v1/jobs/${ids.job}`).set('Authorization', bearer(TECH_FAR.uid));
    expect(techView.body.quotes).toHaveLength(1);

    const accept = await request(app).post(`/v1/jobs/${ids.job}/quotes/${q1.body.quote.id}/accept`).set('Authorization', bearer(CUSTOMER.uid));
    expect(accept.status).toBe(200);
    expect(accept.body.job).toMatchObject({ status: 'assigned', technician_id: ids.tech });
    // WhatsApp is the technician's channel (Section 8): only they get the platform deep link.
    expect(accept.body.whatsappLink).toBeUndefined();
    const assignedTechView = await request(app).get(`/v1/jobs/${ids.job}`).set('Authorization', bearer(TECH.uid));
    expect(assignedTechView.body.whatsappLink).toBe(`https://wa.me/2349000000000?text=${encodeURIComponent(`#${ids.jobRef} `)}`);
    expect((await request(app).get(`/v1/jobs/${ids.job}`).set('Authorization', bearer(CUSTOMER.uid))).body.whatsappLink).toBeNull();
    expect(scheduler.escalations.map((e) => e.data.kind)).toEqual(['no_show']);

    // The losing technician can no longer see the job.
    expect((await request(app).get(`/v1/jobs/${ids.job}`).set('Authorization', bearer(TECH_FAR.uid))).status).toBe(404);
  });

  it('notifies technicians via WhatsApp and routes their replies into the in-app thread', async () => {
    // Customer messages in the app; the technician is also notified via the platform WhatsApp number.
    const m = await request(app).post(`/v1/jobs/${ids.job}/messages`).set('Authorization', bearer(CUSTOMER.uid)).send({ technicianId: ids.tech, body: 'Please come after 2pm' });
    expect(m.status).toBe(201);
    expect(scheduler.notifications.at(-1)).toMatchObject({ userId: ids.tech, message: { whatsapp: true, data: { jobRef: ids.jobRef } } });

    // The technician replies on WhatsApp: it lands in the in-app thread and the customer is notified in the app.
    const reply = await relayInbound({ waMessageId: 'wamid.B', fromE164: TECH.phone, text: `#${ids.jobRef} Noted, see you then`, timestamp: new Date() });
    expect(reply.status).toBe('relayed');
    expect(wa.sent).toEqual([]); // nothing is sent to the customer's WhatsApp
    expect(scheduler.notifications.at(-1)).toMatchObject({ userId: ids.customer, message: { title: 'Tunde replied' } });
    const thread = await request(app).get(`/v1/jobs/${ids.job}/messages?technicianId=${ids.tech}`).set('Authorization', bearer(CUSTOMER.uid));
    expect(thread.body.messages.map((x: { body: string; channel: string }) => [x.channel, x.body])).toEqual([
      ['app', 'Please come after 2pm'],
      ['whatsapp', 'Noted, see you then'],
    ]);

    // Webhook retry with the same id is ignored.
    expect((await relayInbound({ waMessageId: 'wamid.B', fromE164: TECH.phone, text: 'dup', timestamp: new Date() })).status).toBe('duplicate');
    // Customers are pointed back to the app rather than relayed.
    expect((await relayInbound({ waMessageId: 'wamid.A', fromE164: CUSTOMER.phone, text: 'hello', timestamp: new Date() })).status).toBe('customer_use_app');
    expect((await relayInbound({ waMessageId: 'wamid.C', fromE164: '+2348099999999', text: 'hi', timestamp: new Date() })).status).toBe('unknown_sender');
    expect((await relayInbound({ waMessageId: 'wamid.D', fromE164: TECH_FAR.phone, text: 'hi', timestamp: new Date() })).status).toBe('no_conversation');
  });

  it('enforces the job state machine', async () => {
    const skip = await request(app).post(`/v1/jobs/${ids.job}/status`).set('Authorization', bearer(TECH.uid)).send({ status: 'completed' });
    expect(skip.status).toBe(409);
    const wrongTech = await request(app).post(`/v1/jobs/${ids.job}/status`).set('Authorization', bearer(TECH_FAR.uid)).send({ status: 'en_route' });
    expect(wrongTech.status).toBe(403);

    for (const status of ['en_route', 'in_progress', 'completed']) {
      const r = await request(app).post(`/v1/jobs/${ids.job}/status`).set('Authorization', bearer(TECH.uid)).send({ status });
      expect(r.status, status).toBe(200);
    }
    expect(await processEscalation({ kind: 'no_show', jobId: ids.job! })).toBe('skipped');
  });

  it('funds escrow through the gateway and releases it itemized when the completed job is paid', async () => {
    const onboard = await request(app).post('/v1/technicians/me/payout-account').set('Authorization', bearer(TECH.uid)).send({ currency: 'NGN', country: 'NG' });
    expect(onboard.status).toBe(201);

    const pay = await request(app).post(`/v1/jobs/${ids.job}/payments`).set('Authorization', bearer(CUSTOMER.uid));
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ provider: 'mock', settlement: 'escrow', amountMinor: 1_500_000, platformFeeMinor: 270_000, currency: 'NGN' });

    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', reference: pay.body.paymentId, amount: 1_500_000 });
    const bad = await request(app).post('/v1/webhooks/payments/mock').set('x-mock-signature', 'forged').set('Content-Type', 'application/json').send(body);
    expect(bad.status).toBe(401);

    const hook = () =>
      request(app).post('/v1/webhooks/payments/mock').set('x-mock-signature', MockProvider.sign(body)).set('Content-Type', 'application/json').send(body);
    expect((await hook()).body.outcome).toBe('paid');
    expect((await hook()).body.outcome).toBe('duplicate');

    const job = await request(app).get(`/v1/jobs/${ids.job}`).set('Authorization', bearer(CUSTOMER.uid));
    expect(job.body.job.status).toBe('paid');
    const convo = await pool.query('SELECT is_open FROM conversations WHERE job_id = $1', [ids.job]);
    expect(convo.rows[0].is_open).toBe(false);
  });

  it('records a review and updates the technician rating', async () => {
    const r = await request(app).post(`/v1/jobs/${ids.job}/review`).set('Authorization', bearer(CUSTOMER.uid)).send({ scores: fullScores(5), comment: 'Fast and tidy work' });
    expect(r.status).toBe(201);
    const profile = await request(app).get(`/v1/technicians/${ids.tech}`).set('Authorization', bearer(CUSTOMER.uid));
    expect(profile.body.technician).toMatchObject({ rating_avg: 5, rating_count: 1 });
    expect(profile.body.technician.reviews[0].tags).toContain('Punctuality 5★');
    expect(profile.body.technician).not.toHaveProperty('phone_e164');
  });
});
