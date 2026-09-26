import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { InMemoryScheduler, jobs } from '../src/queues/index';
import { LoggingWhatsAppClient, setWhatsAppClient } from '../src/services/messaging/whatsapp';
import { pushToUser } from '../src/services/notifications/push';
import { setStorageDriver } from '../src/services/storage/index';
import { bearer, categoryId, dbAvailable, resetDb } from './helpers';

const hasDb = await dbAvailable();
const app = createApp();
const scheduler = jobs() as InMemoryScheduler;
const wa = new LoggingWhatsAppClient();
setWhatsAppClient(wa);
setStorageDriver({
  createUploadTicket: async ({ kind }) => ({ driver: 's3', storageKey: `${kind}/k`, uploadUrl: 'https://upload.example', method: 'PUT', publicUrl: 'https://cdn.example/f' }),
});

const as = (uid: string) => ({ Authorization: bearer(uid) });
const JOB = { lat: 6.65, lng: 3.35 };
const id: { [k: string]: string } = {};
let plumbing: number;

async function register(uid: string, phone: string, body: Record<string, unknown>) {
  const r = await request(app).post('/v1/auth/register').set('Authorization', bearer(uid, phone)).send(body);
  expect(r.status).toBe(201);
  return r.body.user.id as string;
}
async function postJob() {
  const r = await request(app).post('/v1/jobs').set(as('cust')).send({ categoryId: plumbing, title: 'Fix pump', address: '2 Test Rd', ...JOB, currency: 'NGN' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.job as { id: string; ref: string };
}
async function quote(jobId: string, items: object[]) {
  const r = await request(app).post(`/v1/jobs/${jobId}/quotes`).set(as('tech')).send({ items });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.quote as { id: string };
}
async function evidence(body: Record<string, unknown>) {
  return request(app).post('/v1/uploads').set(as('cust')).send({ kind: 'price_evidence', contentType: 'image/jpeg', ...body });
}
const labor = (n: number) => ({ kind: 'labor', description: 'Labor', quantity: 1, unitPriceMinor: n });
const part = (d: string, n: number) => ({ kind: 'material', description: d, quantity: 1, unitPriceMinor: n, markupBps: 1000 });

describe.skipIf(!hasDb)('Sections 8, 9, 10: masked communication, live tracking, seller registry', () => {
  beforeAll(async () => {
    await resetDb();
    plumbing = await categoryId('plumbing');
    id.admin = await register('admin', '+2348300000001', { role: 'customer', fullName: 'Ops Admin', customerType: 'office' });
    await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL WHERE id = $1`, [id.admin]);
    id.cust = await register('cust', '+2348300000002', { role: 'customer', fullName: 'Ada Customer', customerType: 'homeowner', email: 'ada@example.com' });
    id.other = await register('other', '+2348300000003', { role: 'customer', fullName: 'Other Customer', customerType: 'homeowner' });
    id.tech = await register('tech', '+2348300000010', { role: 'technician', fullName: 'Tunde Tech' });
    await request(app).put('/v1/technicians/me/services').set(as('tech')).send({ services: [{ categoryId: plumbing, laborOnly: 'accept' }] });
    await request(app).put('/v1/technicians/me').set(as('tech')).send({ baseLat: 6.6, baseLng: 3.35, serviceRadiusKm: 20 });
    await request(app).post(`/v1/admin/technicians/${id.tech}/verification`).set(as('admin')).send({ status: 'verified' });
  });
  beforeEach(() => {
    scheduler.reset();
    wa.sent.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  // ------------------------------------------------------------------ Section 8
  describe('masked communication (8)', () => {
    it('releases real contact details only once the job is approved, and logs it', async () => {
      const job = await postJob();
      id.job = job.id;
      id.ref = job.ref;
      const q = await quote(job.id, [labor(50_000)]);
      const locked = await request(app).get(`/v1/jobs/${job.id}/contact`).set(as('tech'));
      expect(locked.status).toBe(403);
      expect(locked.body.error.code).toBe('contact_locked');

      // Pre-approval chat: masked for both parties, original kept for disputes.
      const m = await request(app).post(`/v1/jobs/${job.id}/messages`).set(as('cust')).send({ technicianId: id.tech, body: 'Call me on 0803 111 2222' });
      expect(m.body.message).toMatchObject({ body: 'Call me on [contact hidden]', masked: true });
      // The technician is also notified on WhatsApp (from the platform number); customers never are.
      expect(scheduler.notifications.at(-1)).toMatchObject({ userId: id.tech, message: { whatsapp: true } });
      await request(app).post(`/v1/jobs/${job.id}/messages`).set(as('tech')).send({ body: 'Sure' });
      expect(scheduler.notifications.at(-1)).toMatchObject({ userId: id.cust });
      expect(scheduler.notifications.at(-1)!.message.whatsapp).toBeFalsy();
      const log = await request(app).get(`/v1/admin/jobs/${job.id}/messages`).set(as('admin'));
      expect(log.body.threads[0].messages[0]).toMatchObject({ body: 'Call me on [contact hidden]', original_body: 'Call me on 0803 111 2222', sender_role: 'customer' });
      expect((await request(app).get(`/v1/admin/jobs/${job.id}/messages`).set(as('cust'))).status).toBe(403);

      await request(app).post(`/v1/jobs/${job.id}/quotes/${q.id}/accept`).set(as('cust'));
      const forTech = await request(app).get(`/v1/jobs/${job.id}/contact`).set(as('tech'));
      expect(forTech.body.contact).toEqual({ name: 'Ada Customer', phone: '+2348300000002' });
      const forCust = await request(app).get(`/v1/jobs/${job.id}/contact`).set(as('cust'));
      expect(forCust.body.contact).toEqual({ name: 'Tunde Tech', phone: '+2348300000010' });
      expect((await request(app).get(`/v1/jobs/${job.id}/contact`).set(as('other'))).status).toBe(404);
      const audit = await request(app).get(`/v1/jobs/${job.id}/audit`).set(as('cust'));
      expect(audit.body.entries.filter((e: { action: string }) => e.action === 'contact.released')).toHaveLength(2);
    });

    it('sends WhatsApp fallbacks to technicians only', async () => {
      await pushToUser(id.tech!, { title: 'Customer message', body: 'Hello', data: { jobRef: id.ref!, type: 'chat.message' }, whatsapp: true });
      expect(wa.sent).toEqual([{ to: '+2348300000010', body: expect.stringContaining(`[#${id.ref}] Customer message: Hello`) }]);
      expect(wa.sent[0]!.body).toContain('Reply here');
      await pushToUser(id.cust!, { title: 'x', body: 'y', whatsapp: true });
      expect(wa.sent).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ Section 9
  describe('live location and ETA (9)', () => {
    it('shares en-route position and ETA with the customer only while en route and online', async () => {
      expect((await request(app).get(`/v1/jobs/${id.job}/tracking`).set(as('cust'))).body).toMatchObject({ active: false, status: 'assigned' });
      const early = await request(app).put(`/v1/jobs/${id.job}/location`).set(as('tech')).send({ lat: 6.6, lng: 3.35 });
      expect(early.status).toBe(409);

      await request(app).post(`/v1/jobs/${id.job}/status`).set(as('tech')).send({ status: 'en_route' });
      expect((await request(app).put(`/v1/jobs/${id.job}/location`).set(as('tech')).send({ lat: 6.6, lng: 3.35 })).body.error.code).toBe('disclosure_required');
      await request(app).post('/v1/me/location-disclosure').set(as('tech'));
      expect((await request(app).put(`/v1/jobs/${id.job}/location`).set(as('tech')).send({ lat: 6.6, lng: 3.35 })).body.error.code).toBe('offline');

      await request(app).put('/v1/technicians/me/presence').set(as('tech')).send({ online: true, lat: 6.6, lng: 3.35 });
      expect((await request(app).put(`/v1/jobs/${id.job}/location`).set(as('tech')).send({ lat: 6.6, lng: 3.35, speedMps: 0 })).status).toBe(204);
      const t = await request(app).get(`/v1/jobs/${id.job}/tracking`).set(as('cust'));
      expect(t.body).toMatchObject({ active: true, technicianOnline: true, stale: false, position: { lat: 6.6, lng: 3.35 }, distanceKm: 7.2, etaMinutes: 18 });
      expect((await request(app).get(`/v1/jobs/${id.job}/tracking`).set(as('other'))).status).toBe(404);

      // Going offline ends location sharing immediately.
      await request(app).put('/v1/technicians/me/presence').set(as('tech')).send({ online: false });
      expect((await request(app).get(`/v1/jobs/${id.job}/tracking`).set(as('cust'))).body).toMatchObject({ active: true, position: null, technicianOnline: false });

      await request(app).put('/v1/technicians/me/presence').set(as('tech')).send({ online: true, lat: 6.62, lng: 3.35 });
      await request(app).put(`/v1/jobs/${id.job}/location`).set(as('tech')).send({ lat: 6.64, lng: 3.35, speedMps: 10 });
      // Arriving (in progress) stops tracking and discards the position.
      await request(app).post(`/v1/jobs/${id.job}/status`).set(as('tech')).send({ status: 'in_progress' });
      expect((await request(app).get(`/v1/jobs/${id.job}/tracking`).set(as('cust'))).body.active).toBe(false);
      expect((await pool.query('SELECT count(*)::int AS n FROM job_tracking')).rows[0].n).toBe(0);
    });
  });

  // ------------------------------------------------------------------ Section 10
  describe('seller registry with graduated trust (10)', () => {
    let jobId: string;
    let quoteId: string;
    let pumpId: string;

    it('seeds admin-added sellers as verified and refuses flagged or removed ones at upload', async () => {
      id.alaba = (await request(app).post('/v1/admin/sellers').set(as('admin')).send({ name: 'Alaba Pumps', phone: '+234 801 000 0000', categoryIds: [plumbing] })).body.seller.id;
      id.fraud = (await request(app).post('/v1/admin/sellers').set(as('admin')).send({ name: 'Fake Invoices Ltd' })).body.seller.id;
      expect((await request(app).post(`/v1/admin/sellers/${id.fraud}/status`).set(as('admin')).send({ status: 'flagged' })).status).toBe(400); // needs a reason
      await request(app).post(`/v1/admin/sellers/${id.fraud}/status`).set(as('admin')).send({ status: 'flagged', reason: 'Forged invoices' });
      expect((await evidence({ sellerId: id.fraud })).body.error.code).toBe('unverifiable_evidence');
      const ok = await evidence({ sellerId: id.alaba });
      expect(ok.body.seller).toMatchObject({ status: 'verified', needsReview: false });
      const list = await request(app).get(`/v1/sellers?categoryId=${plumbing}`).set(as('cust'));
      expect(list.body.sellers.map((s: { name: string }) => s.name)).toEqual(['Alaba Pumps']);
    });

    it('sends evidence from an unlisted seller to admin review instead of rejecting it', async () => {
      const job = await postJob();
      jobId = job.id;
      quoteId = (await quote(job.id, [labor(50_000), part('Pump', 300_000)])).id;
      pumpId = (await request(app).get(`/v1/jobs/${job.id}`).set(as('cust'))).body.quotes[0].items.find((i: { kind: string }) => i.kind === 'material').id;

      const up = await evidence({ newSeller: { name: 'Ikeja Plumbing Supplies', phone: '0802 333 4444', city: 'Lagos' } });
      expect(up.status).toBe(201);
      expect(up.body.seller).toMatchObject({ status: 'unlisted', needsReview: true });
      id.ikeja = up.body.seller.id;
      // Naming the same seller again (same name + phone digits) reuses the record.
      expect((await evidence({ newSeller: { name: 'ikeja plumbing supplies', phone: '+234 802 333 4444' } })).body.seller.id).toBe(id.ikeja);

      scheduler.reset();
      const c = await request(app).post(`/v1/jobs/${job.id}/quotes/${quoteId}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 250_000 }], evidenceFileIds: [up.body.fileId] });
      expect(c.status).toBe(201);
      expect(c.body.challenge.status).toBe('pending_review');
      expect(scheduler.challengeSteps).toEqual([]); // the technician's clock hasn't started
      expect(scheduler.notifications.map((n) => n.userId)).toEqual([id.admin]);
      expect((await request(app).post(`/v1/price-challenges/${c.body.challenge.id}/respond`).set(as('tech')).send({ response: 'match' })).status).toBe(409);

      const queue = await request(app).get('/v1/admin/price-challenges').set(as('admin'));
      expect(queue.body.challenges[0]).toMatchObject({ id: c.body.challenge.id, status: 'pending_review' });
      expect(queue.body.challenges[0].evidence[0]).toMatchObject({ seller: 'Ikeja Plumbing Supplies', sellerStatus: 'unlisted' });

      const r = await request(app).post(`/v1/admin/price-challenges/${c.body.challenge.id}/review-evidence`).set(as('admin')).send({ decision: 'accept', note: 'Invoice checks out' });
      expect(r.status).toBe(200);
      expect(scheduler.challengeSteps.length).toBeGreaterThan(0);
      expect(scheduler.notifications.at(-1)).toMatchObject({ userId: id.tech, message: { whatsapp: true } });
      const seller = (await request(app).get('/v1/admin/sellers?q=Ikeja').set(as('admin'))).body.sellers[0];
      expect(seller).toMatchObject({ status: 'provisional', created_via: 'evidence' });
      id.challenge = c.body.challenge.id;
    });

    it('rejected evidence closes the challenge and returns the quote to the customer', async () => {
      await request(app).post(`/v1/price-challenges/${id.challenge}/withdraw`).set(as('cust'));
      const up = await evidence({ newSeller: { name: 'Roadside Seller' } });
      const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${quoteId}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: 100_000 }], evidenceFileIds: [up.body.fileId] });
      await request(app).post(`/v1/admin/price-challenges/${c.body.challenge.id}/review-evidence`).set(as('admin')).send({ decision: 'reject', note: 'Handwritten note, not an invoice' });
      const d = await request(app).get(`/v1/jobs/${jobId}/price-challenges`).set(as('cust'));
      expect(d.body.challenges[0]).toMatchObject({ status: 'evidence_rejected', evidence_review_note: 'Handwritten note, not an invoice' });
      expect((await request(app).get(`/v1/jobs/${jobId}`).set(as('cust'))).body.quotes[0].status).toBe('pending');
    });

    it('auto-verifies provisional sellers after N clean approvals when enabled', async () => {
      await request(app).put('/v1/admin/settings/seller_registry').set(as('admin')).send({ value: { autoVerifyEnabled: true, cleanApprovalsRequired: 2 } });
      for (const price of [280_000, 260_000]) {
        const up = await evidence({ sellerId: id.ikeja });
        expect(up.body.seller.status).toBe('provisional');
        const c = await request(app).post(`/v1/jobs/${jobId}/quotes/${quoteId}/price-challenges`).set(as('cust')).send({ lines: [{ itemId: pumpId, proposedUnitPriceMinor: price }], evidenceFileIds: [up.body.fileId] });
        expect(c.body.challenge.status).toBe('pending'); // provisional sellers are accepted automatically
        await request(app).post(`/v1/price-challenges/${c.body.challenge.id}/respond`).set(as('tech')).send({ response: 'match' });
      }
      const seller = (await request(app).get('/v1/admin/sellers?q=Ikeja').set(as('admin'))).body.sellers[0];
      expect(seller).toMatchObject({ status: 'verified', clean_approvals: 2 });
    });

    it('merges duplicates, moving evidence and approvals to the surviving record', async () => {
      const dup = (await request(app).post('/v1/admin/sellers').set(as('admin')).send({ name: 'Alaba Pump Store', email: 'sales@alaba.example', status: 'provisional' })).body.seller;
      const up = await evidence({ sellerId: dup.id });
      await pool.query('UPDATE spare_parts_sellers SET clean_approvals = 3 WHERE id = $1', [dup.id]);
      const m = await request(app).post(`/v1/admin/sellers/${dup.id}/merge`).set(as('admin')).send({ intoId: id.alaba });
      expect(m.body.seller).toMatchObject({ id: id.alaba, status: 'verified', clean_approvals: 3, email: 'sales@alaba.example' });
      expect((await pool.query('SELECT seller_id FROM files WHERE id = $1', [up.body.fileId])).rows[0].seller_id).toBe(id.alaba);
      // Citing the merged record resolves to the survivor.
      expect((await evidence({ sellerId: dup.id })).body.seller.id).toBe(id.alaba);
      expect((await request(app).post(`/v1/admin/sellers/${dup.id}/merge`).set(as('admin')).send({ intoId: id.alaba })).status).toBe(409);
    });

    it('lets admins upgrade provisional sellers and remove fraudulent ones', async () => {
      const s = (await evidence({ newSeller: { name: 'New Seller Co' } })).body.seller;
      await request(app).post(`/v1/admin/sellers/${s.id}/status`).set(as('admin')).send({ status: 'verified' });
      expect((await evidence({ sellerId: s.id })).body.seller.status).toBe('verified');
      await request(app).post(`/v1/admin/sellers/${s.id}/status`).set(as('admin')).send({ status: 'removed', reason: 'Closed business' });
      expect((await evidence({ sellerId: s.id })).status).toBe(422);
    });
  });
});
