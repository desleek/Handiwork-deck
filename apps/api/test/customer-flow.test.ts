import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { processEscalation } from '../src/queues/escalations';
import { InMemoryScheduler, jobs } from '../src/queues/index';
import { relayInbound } from '../src/services/messaging/relay';
import { LoggingWhatsAppClient, setWhatsAppClient } from '../src/services/messaging/whatsapp';
import { MockProvider } from '../src/services/payments/providers/mock';
import { bearer, categoryId, dbAvailable, fullScores, laborQuote, resetDb } from './helpers';

const hasDb = await dbAvailable();
const app = createApp();
const scheduler = jobs() as InMemoryScheduler;
const wa = new LoggingWhatsAppClient();
setWhatsAppClient(wa);

const as = (uid: string) => ({ Authorization: bearer(uid) });
const LAGOS = { lat: 6.6018, lng: 3.3515 };

const U = {
  admin: { uid: 'admin', phone: '+2348000000001' },
  cust: { uid: 'cust', phone: '+2348000000002' },
  cust2: { uid: 'cust2', phone: '+2348000000003' },
  alice: { uid: 'alice', phone: '+2348000000010' }, // plumber, boosted, instant book
  bola: { uid: 'bola', phone: '+2348000000011' }, // plumber, no labor-only
  chidi: { uid: 'chidi', phone: '+2348000000012' }, // plumber, far away
};
const id: Record<string, string> = {};
let plumbing: number;
let otherHousehold: number;

async function register(u: { uid: string; phone: string }, body: Record<string, unknown>) {
  const r = await request(app).post('/v1/auth/register').set('Authorization', bearer(u.uid, u.phone)).send(body);
  expect(r.status).toBe(201);
  return r.body.user.id as string;
}

async function webhook(body: object) {
  const raw = JSON.stringify(body);
  return request(app).post('/v1/webhooks/payments/mock').set('x-mock-signature', MockProvider.sign(raw)).set('Content-Type', 'application/json').send(raw);
}

async function postJob(uid: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post('/v1/jobs')
    .set(as(uid))
    .send({ categoryId: plumbing, title: 'Fix bathroom tap', address: '1 Test St, Ikeja', ...LAGOS, currency: 'NGN', ...extra });
}

/** Drives a freshly-posted job to `completed` through quote approval. */
async function completeJobWith(techUid: string, customerUid: string, amount = 10_000) {
  const job = (await postJob(customerUid)).body.job;
  const q = await request(app).post(`/v1/jobs/${job.id}/quotes`).set(as(techUid)).send(laborQuote(amount));
  await request(app).post(`/v1/jobs/${job.id}/quotes/${q.body.quote.id}/accept`).set(as(customerUid));
  for (const status of ['en_route', 'in_progress', 'completed']) {
    const r = await request(app).post(`/v1/jobs/${job.id}/status`).set(as(techUid)).send({ status });
    expect(r.status).toBe(200);
  }
  return job.id as string;
}

describe.skipIf(!hasDb)('Section 2 & 3: taxonomy and customer flow', () => {
  beforeAll(async () => {
    await resetDb();
    plumbing = await categoryId('plumbing');
    otherHousehold = await categoryId('other-household');
    id.admin = await register(U.admin, { role: 'customer', fullName: 'Ops Admin', customerType: 'office' });
    await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL WHERE id = $1`, [id.admin]);
    id.cust = await register(U.cust, { role: 'customer', fullName: 'Ada Customer', customerType: 'sme', companyName: 'Ada Ventures', email: 'ada@example.com' });
    id.cust2 = await register(U.cust2, { role: 'customer', fullName: 'Ben Customer', customerType: 'homeowner', email: 'ben@example.com' });
    for (const [key, name, loc] of [
      ['alice', 'Alice Pipes', { baseLat: 6.60, baseLng: 3.35 }],
      ['bola', 'Bola Water', { baseLat: 6.61, baseLng: 3.36 }],
      ['chidi', 'Chidi Far', { baseLat: 6.45, baseLng: 3.60 }], // ~33 km away
    ] as const) {
      id[key] = await register(U[key], { role: 'technician', fullName: name });
      await request(app).put('/v1/technicians/me').set(as(U[key].uid)).send({ ...loc, serviceRadiusKm: 15 });
      await request(app).put('/v1/technicians/me/services').set(as(U[key].uid)).send({ services: [{ categoryId: plumbing, baseRateMinor: 800_000, currency: 'NGN', laborOnly: 'accept' }] });
      await request(app).post(`/v1/admin/technicians/${id[key]}/verification`).set(as(U.admin.uid)).send({ status: 'verified' });
    }
    // Bola declared "no labor-only" for plumbing at onboarding. Declarations start their cooldown when made,
    // so clear Bola's initial one to allow this re-declaration in the test.
    await pool.query('DELETE FROM technician_labor_only_declarations WHERE technician_id = $1', [id.bola]);
    await request(app).put('/v1/technicians/me/services').set(as(U.bola.uid)).send({ services: [{ categoryId: plumbing, baseRateMinor: 500_000, currency: 'NGN', laborOnly: 'decline' }] });
  });
  beforeEach(() => {
    scheduler.reset();
    wa.sent.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  // ------------------------------------------------------------------ Section 2
  describe('taxonomy', () => {
    it('ships both supercategories with the launch list', async () => {
      const r = await request(app).get('/v1/categories');
      expect(r.body.segments).toEqual([
        { key: 'household_office', label: 'Household & Office Technical Support' },
        { key: 'construction_plant', label: 'Construction & Plant Erection' },
      ]);
      const slugs = r.body.categories.map((c: { slug: string }) => c.slug);
      for (const s of ['hvac-ac-repair', 'dj', 'vulcanizer', 'fire-safety', 'iron-bending', 'land-piling', 'window-fixing', 'other-construction']) {
        expect(slugs).toContain(s);
      }
      expect(r.body.categories).toHaveLength(71);
    });

    it('lets admins add, edit and deactivate categories (and nobody else)', async () => {
      expect((await request(app).post('/v1/admin/categories').set(as(U.cust.uid)).send({ name: 'X', segment: 'household_office' })).status).toBe(403);
      const created = await request(app).post('/v1/admin/categories').set(as(U.admin.uid)).send({ name: 'Gate Automation', segment: 'household_office', icon: 'lock-open' });
      expect(created.status).toBe(201);
      expect(created.body.category.slug).toBe('gate-automation');
      const catId = created.body.category.id;

      const edited = await request(app).patch(`/v1/admin/categories/${catId}`).set(as(U.admin.uid)).send({ name: 'Gate & Garage Automation' });
      expect(edited.body.category.name).toBe('Gate & Garage Automation');

      await request(app).patch(`/v1/admin/categories/${catId}`).set(as(U.admin.uid)).send({ isActive: false });
      const list = await request(app).get('/v1/categories');
      expect(list.body.categories.map((c: { id: number }) => c.id)).not.toContain(catId);
      const post = await postJob(U.cust2.uid, { categoryId: catId });
      expect(post.status).toBe(400);
      const all = await request(app).get('/v1/admin/categories').set(as(U.admin.uid));
      expect(all.body.categories.find((c: { id: number }) => c.id === catId).is_active).toBe(false);
    });

    it('holds "Other/custom" jobs for admin approval, then releases them into the approved category', async () => {
      expect((await postJob(U.cust2.uid, { categoryId: otherHousehold })).status).toBe(400); // needs a name
      const r = await postJob(U.cust2.uid, { categoryId: otherHousehold, customServiceName: 'Water tank cleaning', title: 'Clean 2 overhead tanks' });
      expect(r.status).toBe(201);
      expect(r.body.job.awaiting_category_review).toBe(true);
      expect(r.body.matchedTechnicians).toBe(0);
      const jobId = r.body.job.id;

      const s = await request(app).get('/v1/admin/category-suggestions').set(as(U.admin.uid));
      const suggestion = s.body.suggestions.find((x: { job_id: string }) => x.job_id === jobId);
      expect(suggestion).toMatchObject({ name: 'Water tank cleaning', segment: 'household_office' });

      // Map it onto plumbing: the job moves there and plumbers get notified.
      const ok = await request(app).post(`/v1/admin/category-suggestions/${suggestion.id}/approve`).set(as(U.admin.uid)).send({ existingCategoryId: plumbing });
      expect(ok.status).toBe(200);
      const job = await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust2.uid));
      expect(job.body.job).toMatchObject({ category_id: plumbing, awaiting_category_review: false });
      expect(scheduler.notifications.map((n) => n.userId)).toEqual(expect.arrayContaining([id.alice, id.bola, id.cust2]));
      await request(app).post(`/v1/jobs/${jobId}/status`).set(as(U.cust2.uid)).send({ status: 'cancelled' });
    });

    it('turns an approved technician trade suggestion into a category on their profile', async () => {
      const s = await request(app).post('/v1/categories/suggestions').set(as(U.chidi.uid)).send({ name: 'Swimming Pool Maintenance', segment: 'household_office' });
      expect(s.status).toBe(400); // must declare labor-only for the trade
      const s2 = await request(app).post('/v1/categories/suggestions').set(as(U.chidi.uid)).send({ name: 'Swimming Pool Maintenance', segment: 'household_office', laborOnly: 'accept' });
      expect(s2.status).toBe(201);
      expect((await request(app).post(`/v1/admin/category-suggestions/${s2.body.suggestion.id}/approve`).set(as(U.admin.uid)).send({ icon: 'water' })).status).toBe(200);
      const profile = await request(app).get(`/v1/technicians/${id.chidi}`).set(as(U.cust.uid));
      expect(profile.body.technician.services.map((x: { name: string }) => x.name)).toContain('Swimming Pool Maintenance');
    });
  });

  // ------------------------------------------------------------------ Section 3: discovery & profile
  describe('discovery and profiles', () => {
    it('shows boosted technicians first and labelled, with photo, icon, rating and starting price', async () => {
      await request(app).post('/v1/admin/boosts').set(as(U.admin.uid)).send({ technicianId: id.chidi, days: 7, priority: 10 });
      const r = await request(app).get(`/v1/discover?categoryId=${plumbing}&lat=${LAGOS.lat}&lng=${LAGOS.lng}&radiusKm=50`).set(as(U.cust.uid));
      expect(r.status).toBe(200);
      expect(r.body.boosted.map((c: { id: string }) => c.id)).toEqual([id.chidi]);
      expect(r.body.boosted[0].boosted).toBe(true);
      const organic = r.body.organic.map((c: { id: string }) => c.id);
      expect(organic).toEqual(expect.arrayContaining([id.alice, id.bola]));
      expect(organic).not.toContain(id.chidi);
      const bola = r.body.organic.find((c: { id: string }) => c.id === id.bola);
      expect(bola).toMatchObject({
        category: { id: plumbing, name: 'Plumbing', icon: 'water' },
        startingPrice: { amountMinor: 500_000, currency: 'NGN' },
        laborOnly: 'decline',
        performance: { multiplier: 1, tierStars: null },
      });

      // Radius filter: Chidi (~33 km) drops out at 10 km.
      const near = await request(app).get(`/v1/discover?categoryId=${plumbing}&lat=${LAGOS.lat}&lng=${LAGOS.lng}&radiusKm=10`).set(as(U.cust.uid));
      expect([...near.body.boosted, ...near.body.organic].map((c: { id: string }) => c.id)).not.toContain(id.chidi);
    });

    it('shows live positions only for technicians online recently', async () => {
      await request(app).put('/v1/technicians/me/presence').set(as(U.alice.uid)).send({ online: true, lat: 6.60123, lng: 3.35456 });
      const r = await request(app).get(`/v1/discover?categoryId=${plumbing}`).set(as(U.cust.uid));
      const all = [...r.body.boosted, ...r.body.organic];
      expect(all.find((c: { id: string }) => c.id === id.alice).livePosition).toEqual({ lat: 6.601, lng: 3.355 });
      expect(all.find((c: { id: string }) => c.id === id.bola).livePosition).toBeNull();
      await pool.query(`UPDATE technician_profiles SET live_at = now() - interval '1 hour' WHERE user_id = $1`, [id.alice]);
      const later = await request(app).get(`/v1/discover?categoryId=${plumbing}`).set(as(U.cust.uid));
      expect([...later.body.boosted, ...later.body.organic].find((c: { id: string }) => c.id === id.alice).livePosition).toBeNull();
    });

    it('caps the portfolio at 5 images and lists certifications', async () => {
      const files = await pool.query(
        `INSERT INTO files (owner_id, kind, driver, storage_key, url)
         SELECT $1, 'portfolio', 's3', 'k' || g, 'https://cdn.example/p' || g || '.jpg' FROM generate_series(1, 6) g RETURNING id`,
        [id.alice],
      );
      for (const [i, f] of files.rows.entries()) {
        const r = await request(app).post('/v1/technicians/me/portfolio').set(as(U.alice.uid)).send({ fileId: f.id });
        expect(r.status, `image ${i + 1}`).toBe(i < 5 ? 201 : 409);
      }
      const cert = await request(app).post('/v1/technicians/me/certifications').set(as(U.alice.uid)).send({ title: 'COREN Plumbing Cert', issuer: 'COREN' });
      expect(cert.status).toBe(201);
      await request(app).post(`/v1/admin/certifications/${cert.body.certification.id}/verify`).set(as(U.admin.uid)).send({});
      const p = await request(app).get(`/v1/technicians/${id.alice}`).set(as(U.cust.uid));
      expect(p.body.technician.portfolio).toHaveLength(5);
      expect(p.body.technician.certifications[0]).toMatchObject({ title: 'COREN Plumbing Cert', is_verified: true });
      expect(p.body.technician).toMatchObject({ performance: { tierStars: null } });
      expect(p.body.technician.services[0].labor_only_policy).toBe('accept');
    });
  });

  // ------------------------------------------------------------------ booking modes
  describe('request booking and instant book', () => {
    it('sends a booking request to one technician only, and opens it up if they do not respond', async () => {
      const r = await postJob(U.cust.uid, { bookingMode: 'request', technicianId: id.bola });
      expect(r.status).toBe(201);
      const jobId = r.body.job.id;
      expect(scheduler.notifications.map((n) => n.userId)).toEqual([id.bola]);
      expect((await request(app).get(`/v1/jobs/${jobId}`).set(as(U.alice.uid))).status).toBe(404);
      expect((await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(U.alice.uid)).send(laborQuote(5000))).status).toBe(403);
      const feed = await request(app).get('/v1/jobs?feed=nearby').set(as(U.bola.uid));
      expect(feed.body.jobs.find((j: { id: string }) => j.id === jobId).is_request_to_me).toBe(true);

      scheduler.reset();
      expect(await processEscalation({ kind: 'no_quote_widen', jobId })).toBe('opened_to_marketplace');
      expect(scheduler.notifications.map((n) => n.userId)).toContain(id.alice);
      expect(scheduler.escalations[0]!.data).toMatchObject({ kind: 'no_quote_widen', round: 2 });
      expect((await request(app).get(`/v1/jobs/${jobId}`).set(as(U.alice.uid))).status).toBe(200);
      await request(app).post(`/v1/jobs/${jobId}/status`).set(as(U.cust.uid)).send({ status: 'cancelled' });
    });

    it('instant-books only technicians who enabled it, at their listed rate', async () => {
      const refused = await postJob(U.cust.uid, { bookingMode: 'instant', technicianId: id.alice });
      expect(refused.status).toBe(409);
      await request(app).put('/v1/technicians/me').set(as(U.alice.uid)).send({ instantBookEnabled: true });
      const r = await postJob(U.cust.uid, { bookingMode: 'instant', technicianId: id.alice });
      expect(r.status).toBe(201);
      expect(r.body.job).toMatchObject({ status: 'assigned', technician_id: id.alice, budget_minor: 800_000, booking_mode: 'instant' });
      expect(scheduler.escalations.map((e) => e.data.kind)).toEqual(['no_show']);
      await request(app).post(`/v1/jobs/${r.body.job.id}/status`).set(as(U.cust.uid)).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ quotes & counters
  describe('itemized quotes and counter-offers', () => {
    const items = [
      { kind: 'labor', description: 'Replace cistern', quantity: 1, unitPriceMinor: 2_000_000 },
      { kind: 'material', description: 'Cistern unit', quantity: 1, unitPriceMinor: 4_500_000 },
      { kind: 'material', description: 'Fittings', quantity: 5, unitPriceMinor: 100_000 },
      { kind: 'labor', description: 'Transport / call-out', quantity: 1, unitPriceMinor: 300_000 },
    ];
    let jobId: string;
    let aliceQuote: string;
    let bolaQuote: string;

    it('stores line items with labor / materials breakdown', async () => {
      jobId = (await postJob(U.cust.uid, { title: 'Replace toilet cistern' })).body.job.id;
      const a = await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(U.alice.uid)).send({ items });
      expect(a.status).toBe(201);
      expect(a.body.quote).toMatchObject({ amount_minor: 7_300_000, labor_minor: 2_300_000, materials_minor: 5_000_000, parts_base_minor: 5_000_000 });
      aliceQuote = a.body.quote.id;
      bolaQuote = (await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(U.bola.uid)).send({ items })).body.quote.id;
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust.uid));
      expect(d.body.quotes[0].items).toHaveLength(4);
    });

    it('validates counters against the quote and the technician stance', async () => {
      const c = (quoteId: string, body: object) => request(app).post(`/v1/jobs/${jobId}/quotes/${quoteId}/counter`).set(as(U.cust.uid)).send(body);
      expect((await c(bolaQuote, { kind: 'labor_only' })).body.error.message).toMatch(/no labor-only/);
      // Parts price challenges are a separate evidence-backed flow, not a counter.
      expect((await c(aliceQuote, { kind: 'price_challenge', proposedTotalMinor: 6_000_000, message: 'x' })).status).toBe(400);
      expect((await c(aliceQuote, { kind: 'labor_negotiation', proposedLaborMinor: 2_500_000 })).status).toBe(409);
    });

    it('lets the technician decline a counter, restoring the original quote', async () => {
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${bolaQuote}/counter`).set(as(U.cust.uid)).send({ kind: 'labor_negotiation', proposedLaborMinor: 1_500_000 });
      expect(c.status).toBe(201);
      expect(c.body.counter.proposed_total_minor).toBe(6_500_000);
      // Can't approve while the counter is pending, or stack a second counter.
      expect((await request(app).post(`/v1/jobs/${jobId}/quotes/${bolaQuote}/accept`).set(as(U.cust.uid))).status).toBe(409);
      const r = await request(app).post(`/v1/jobs/${jobId}/quotes/${bolaQuote}/counters/${c.body.counter.id}/respond`).set(as(U.bola.uid)).send({ decision: 'decline' });
      expect(r.status).toBe(200);
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust.uid));
      expect(d.body.quotes.find((q: { id: string }) => q.id === bolaQuote)).toMatchObject({ status: 'pending', latest_counter: { status: 'declined' } });
    });

    it('revising a quote supersedes a pending counter', async () => {
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${bolaQuote}/counter`).set(as(U.cust.uid)).send({ kind: 'labor_negotiation', proposedLaborMinor: 1_800_000 });
      const rev = await request(app).put(`/v1/jobs/${jobId}/quotes/${bolaQuote}`).set(as(U.bola.uid)).send({ items: items.slice(0, 2) });
      expect(rev.body.quote).toMatchObject({ revision: 2, status: 'pending', amount_minor: 6_500_000 });
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust.uid));
      expect(d.body.quotes.find((q: { id: string }) => q.id === bolaQuote).latest_counter).toMatchObject({ id: c.body.counter.id, status: 'superseded' });
    });

    it('accepting a labor-only counter drops materials and hires the technician at that price', async () => {
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${aliceQuote}/counter`).set(as(U.cust.uid)).send({ kind: 'labor_only', message: 'I will buy the cistern' });
      expect(c.body.counter.proposed_total_minor).toBe(2_300_000); // labor + call-out
      const r = await request(app).post(`/v1/jobs/${jobId}/quotes/${aliceQuote}/counters/${c.body.counter.id}/respond`).set(as(U.alice.uid)).send({ decision: 'accept' });
      expect(r.status).toBe(200);
      expect(r.body.job).toMatchObject({ status: 'assigned', technician_id: id.alice, budget_minor: 2_300_000, labor_only: true });
      const d = await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust.uid));
      const q = d.body.quotes.find((x: { id: string }) => x.id === aliceQuote);
      expect(q.items.map((i: { kind: string }) => i.kind)).toEqual(['labor', 'labor']);
      expect(d.body.quotes.find((x: { id: string }) => x.id === bolaQuote).status).toBe('rejected');
      await request(app).post(`/v1/jobs/${jobId}/status`).set(as(U.cust.uid)).send({ status: 'cancelled' });
    });

    it('an accepted labor negotiation adds a job-only labor adjustment line', async () => {
      const j = (await postJob(U.cust.uid)).body.job.id;
      const q = (await request(app).post(`/v1/jobs/${j}/quotes`).set(as(U.bola.uid)).send({ items })).body.quote.id;
      const c = await request(app).post(`/v1/jobs/${j}/quotes/${q}/counter`).set(as(U.cust.uid)).send({ kind: 'labor_negotiation', proposedLaborMinor: 2_000_000 });
      const r = await request(app).post(`/v1/jobs/${j}/quotes/${q}/counters/${c.body.counter.id}/respond`).set(as(U.bola.uid)).send({ decision: 'accept' });
      expect(r.body.job.budget_minor).toBe(7_000_000);
      const d = await request(app).get(`/v1/jobs/${j}`).set(as(U.cust.uid));
      expect(d.body.quotes[0].items.at(-1)).toMatchObject({ kind: 'adjustment', applies_to: 'labor', total_minor: -300_000 });
      await request(app).post(`/v1/jobs/${j}/status`).set(as(U.cust.uid)).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ chat
  describe('masked chat', () => {
    it('masks contact details before approval, over both in-app chat and WhatsApp', async () => {
      const jobId = (await postJob(U.cust2.uid)).body.job.id;
      // Customers can only open threads with engaged technicians.
      expect((await request(app).post(`/v1/jobs/${jobId}/messages`).set(as(U.cust2.uid)).send({ technicianId: id.bola, body: 'hi' })).status).toBe(403);

      const m = await request(app).post(`/v1/jobs/${jobId}/messages`).set(as(U.bola.uid)).send({ body: 'I can come today, call 0803 555 1234' });
      expect(m.status).toBe(201);
      expect(m.body.message).toMatchObject({ body: 'I can come today, call [contact hidden]', masked: true });
      expect(scheduler.notifications.at(-1)!.userId).toBe(id.cust2);

      const thread = await request(app).get(`/v1/jobs/${jobId}/messages?technicianId=${id.bola}`).set(as(U.cust2.uid));
      expect(thread.body).toMatchObject({ contactUnlocked: false });
      expect(thread.body.messages).toHaveLength(1);

      const quote = (await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(U.bola.uid)).send(laborQuote(10_000))).body.quote;
      await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as(U.alice.uid)).send(laborQuote(12_000));
      const reply = await request(app).post(`/v1/jobs/${jobId}/messages`).set(as(U.cust2.uid)).send({ technicianId: id.alice, body: 'email me: ben@example.com' });
      expect(reply.body.message.body).toBe('email me: [contact hidden]');

      await request(app).post(`/v1/jobs/${jobId}/quotes/${quote.id}/accept`).set(as(U.cust2.uid));
      const after = await request(app).post(`/v1/jobs/${jobId}/messages`).set(as(U.bola.uid)).send({ body: 'My number is 0803 555 1234' });
      expect(after.body.message).toMatchObject({ body: 'My number is 0803 555 1234', masked: false });
      // Alice wasn't hired: her thread is closed.
      expect((await request(app).post(`/v1/jobs/${jobId}/messages`).set(as(U.cust2.uid)).send({ technicianId: id.alice, body: 'sorry' })).status).toBe(409);

      // WhatsApp relay routes to the hired technician's thread.
      const ref = (await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust2.uid))).body.job.ref;
      expect((await relayInbound({ waMessageId: 'w1', fromE164: U.cust2.phone, text: `#${ref} gate code is 1234`, timestamp: new Date() })).status).toBe('relayed');
      expect(wa.sent.at(-1)!.to).toBe(U.bola.phone);
      await request(app).post(`/v1/jobs/${jobId}/status`).set(as(U.cust2.uid)).send({ status: 'cancelled' });
    });
  });

  // ------------------------------------------------------------------ payments & reviews
  describe('payment methods, wallet and mandatory reviews', () => {
    it('lists card, virtual account, USSD and wallet options', async () => {
      const r = await request(app).get('/v1/payments/options?currency=NGN').set(as(U.cust.uid));
      expect(r.body.methods.map((m: { method: string }) => m.method)).toEqual(['card', 'bank_transfer', 'ussd', 'wallet']);
      expect(r.body.methods.find((m: { method: string }) => m.method === 'wallet').balanceMinor).toBe(0);
    });

    it('tops up the wallet through a gateway and credits it once on the webhook', async () => {
      const t = await request(app).post('/v1/wallet/topups').set(as(U.cust.uid)).send({ amountMinor: 5_000_000, currency: 'NGN', method: 'bank_transfer' });
      expect(t.status).toBe(201);
      expect(t.body.checkoutUrl).toContain('methods=bank_transfer');
      const ev = { id: 'evt_topup', type: 'payment.succeeded', reference: t.body.paymentId, amount: 5_000_000 };
      expect((await webhook(ev)).body.outcome).toBe('wallet_credited');
      expect((await webhook({ ...ev, id: 'evt_topup_retry' })).body.outcome).toBe('already_succeeded');
      const w = await request(app).get('/v1/wallet').set(as(U.cust.uid));
      expect(w.body.balances).toEqual([{ currency: 'NGN', balance_minor: 5_000_000 }]);
    });

    it('pays a job from the wallet: instant settlement, technician credited net of fee', async () => {
      const jobId = await completeJobWith(U.alice.uid, U.cust.uid, 1_000_000);
      const pay = await request(app).post(`/v1/jobs/${jobId}/payments`).set(as(U.cust.uid)).send({ method: 'wallet' });
      expect(pay.status, JSON.stringify(pay.body)).toBe(201);
      expect(pay.body).toMatchObject({ status: 'succeeded', method: 'wallet', amountMinor: 1_000_000, platformFeeMinor: 180_000 });
      expect((await request(app).get(`/v1/jobs/${jobId}`).set(as(U.cust.uid))).body.job.status).toBe('paid');
      const tw = await request(app).get('/v1/wallet').set(as(U.alice.uid));
      expect(tw.body.balances).toEqual([{ currency: 'NGN', balance_minor: 820_000 }]);
      const cw = await request(app).get('/v1/wallet').set(as(U.cust.uid));
      expect(cw.body.balances[0].balance_minor).toBe(4_000_000);
      id.paidJob = jobId;
    });

    it('blocks new bookings until the completed job is reviewed with every category and a comment', async () => {
      const blocked = await postJob(U.cust.uid);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('review_required');
      expect(blocked.body.error.details.jobs[0].id).toBe(id.paidJob);
      expect((await request(app).get('/v1/me/pending-reviews').set(as(U.cust.uid))).body.jobs).toHaveLength(1);

      const partial = await request(app).post(`/v1/jobs/${id.paidJob}/review`).set(as(U.cust.uid)).send({ scores: { quality: 5, competence: 5 }, comment: 'Great job overall' });
      expect(partial.status).toBe(400);
      const short = await request(app).post(`/v1/jobs/${id.paidJob}/review`).set(as(U.cust.uid)).send({ scores: fullScores(4), comment: 'ok' });
      expect(short.status).toBe(400);
      const ok = await request(app)
        .post(`/v1/jobs/${id.paidJob}/review`)
        .set(as(U.cust.uid))
        .send({ scores: { competence: 5, punctuality: 5, professionalism: 5, courtesy: 4, timeline: 4, transparency: 5, quality: 5 }, comment: 'Neat work, arrived on time' });
      expect(ok.status).toBe(201);
      expect(ok.body.review.overall).toBe(4.71);
      expect((await postJob(U.cust.uid)).status).toBe(201);

      const p = await request(app).get(`/v1/technicians/${id.alice}`).set(as(U.cust2.uid));
      expect(p.body.technician.categoryScores).toMatchObject({ quality: 5, courtesy: 4 });
      expect(p.body.technician.reviews[0]).toMatchObject({ comment: 'Neat work, arrived on time', category_name: 'Plumbing' });
    });

    it('rejects a wallet payment without enough balance', async () => {
      const jobId = await completeJobWith(U.bola.uid, U.cust2.uid, 1_000_000);
      const r = await request(app).post(`/v1/jobs/${jobId}/payments`).set(as(U.cust2.uid)).send({ method: 'wallet' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('insufficient_funds');
      expect((await pool.query('SELECT count(*)::int AS n FROM wallet_ledger WHERE user_id = $1', [id.cust2])).rows[0].n).toBe(0);
      id.unpaidJob = jobId;
    });

    it('collects on the platform and credits the technician wallet when they have no payout account', async () => {
      const pay = await request(app).post(`/v1/jobs/${id.unpaidJob}/payments`).set(as(U.cust2.uid)).send({ method: 'ussd' });
      expect(pay.body).toMatchObject({ settlement: 'platform_collect', method: 'ussd' });
      expect((await webhook({ id: 'evt_pc', type: 'payment.succeeded', reference: pay.body.paymentId, amount: 1_000_000 })).body.outcome).toBe('paid');
      const tw = await request(app).get('/v1/wallet').set(as(U.bola.uid));
      expect(tw.body.balances).toEqual([{ currency: 'NGN', balance_minor: 820_000 }]);
    });

    it('refunds a wallet payment back to the customer wallet', async () => {
      const payment = (await pool.query(`SELECT id FROM payments WHERE job_id = $1`, [id.paidJob])).rows[0];
      const r = await request(app).post(`/v1/admin/payments/${payment.id}/refund`).set(as(U.admin.uid)).send({});
      expect(r.body.status).toBe('refunded_to_wallet');
      expect((await request(app).get('/v1/wallet').set(as(U.alice.uid))).body.balances[0].balance_minor).toBe(0);
      expect((await request(app).get('/v1/wallet').set(as(U.cust.uid))).body.balances[0].balance_minor).toBe(5_000_000);
    });
  });
});
