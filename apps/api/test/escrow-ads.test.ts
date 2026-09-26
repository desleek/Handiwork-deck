import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { interleave } from '../src/modules/advertising/service';
import { InMemoryScheduler, jobs } from '../src/queues/index';
import { runEscrowAutoRelease } from '../src/services/escrow';
import { gatewayCandidates, getRegistration, type PaymentProvider, registerProvider } from '../src/services/payments/index';
import { MockProvider } from '../src/services/payments/providers/mock';
import { bearer, categoryId, dbAvailable, fullScores, resetDb } from './helpers';

const hasDb = await dbAvailable();
const app = createApp();
const scheduler = jobs() as InMemoryScheduler;
const as = (uid: string) => ({ Authorization: bearer(uid) });
const LAGOS = { lat: 6.5244, lng: 3.3792 };
const id: Record<string, string> = {};
let plumbing: number;

async function register(uid: string, phone: string, body: Record<string, unknown>) {
  const r = await request(app).post('/v1/auth/register').set('Authorization', bearer(uid, phone)).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.id as string;
}
const webhook = (ev: Record<string, unknown>) => {
  const raw = JSON.stringify(ev);
  return request(app).post('/v1/webhooks/payments/mock').set('x-mock-signature', MockProvider.sign(raw)).set('Content-Type', 'application/json').send(raw);
};
async function acceptedJob(amount = 1_000_000, cust = 'cust') {
  const j = await request(app).post('/v1/jobs').set(as(cust)).send({ categoryId: plumbing, title: 'Fix leak', address: '3 Test Rd', ...LAGOS, currency: 'NGN' });
  expect(j.status, JSON.stringify(j.body)).toBe(201);
  const q = await request(app).post(`/v1/jobs/${j.body.job.id}/quotes`).set(as('tech')).send({ items: [{ kind: 'labor', description: 'Labor', quantity: 1, unitPriceMinor: amount }] });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  expect((await request(app).post(`/v1/jobs/${j.body.job.id}/quotes/${q.body.quote.id}/accept`).set(as(cust))).status).toBe(200);
  return j.body.job.id as string;
}
async function fundByCard(jobId: string, cust = 'cust') {
  const pay = await request(app).post(`/v1/jobs/${jobId}/payments`).set(as(cust)).send({ method: 'card' });
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const hook = await webhook({ id: `evt_${pay.body.paymentId}`, type: 'payment.succeeded', reference: pay.body.paymentId, amount: pay.body.amountMinor });
  return { pay: pay.body, outcome: hook.body.outcome as string };
}
const status = (jobId: string, s: string, who = 'tech') => request(app).post(`/v1/jobs/${jobId}/status`).set(as(who)).send({ status: s });
async function walletOf(uid: string) {
  const w = await request(app).get('/v1/wallet').set(as(uid));
  return Number(w.body.balances.find((b: { currency: string }) => b.currency === 'NGN')?.balance_minor ?? 0);
}
async function review(jobId: string, cust = 'cust') {
  await request(app).post(`/v1/jobs/${jobId}/review`).set(as(cust)).send({ scores: fullScores(5), comment: 'Great work, thanks' });
}

describe.skipIf(!hasDb)('Sections 11 & 12: payment channels with escrow, advertising module', () => {
  beforeAll(async () => {
    await resetDb();
    plumbing = await categoryId('plumbing');
    id.admin = await register('admin', '+2348400000001', { role: 'customer', fullName: 'Ops Admin', customerType: 'office' });
    await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL WHERE id = $1`, [id.admin]);
    id.cust = await register('cust', '+2348400000002', { role: 'customer', fullName: 'Ada Customer', customerType: 'homeowner', email: 'ada@example.com' });
    id.cust2 = await register('cust2', '+2348400000003', { role: 'customer', fullName: 'Ben Customer', customerType: 'sme' });
    id.tech = await register('tech', '+2348400000010', { role: 'technician', fullName: 'Tunde Tech' });
    await request(app).put('/v1/technicians/me/services').set(as('tech')).send({ services: [{ categoryId: plumbing, laborOnly: 'accept' }] });
    await request(app).put('/v1/technicians/me').set(as('tech')).send({ baseLat: 6.52, baseLng: 3.38, serviceRadiusKm: 25 });
    await request(app).post(`/v1/admin/technicians/${id.tech}/verification`).set(as('admin')).send({ status: 'verified' });
    id.adv = await register('adv', '+2348400000020', { role: 'advertiser', fullName: 'Parts Hub', companyName: 'Parts Hub Ltd' });
  });
  beforeEach(() => scheduler.reset());
  afterAll(async () => {
    await pool.end();
  });

  // ================================================================== Section 11
  describe('escrow hold -> itemized capture -> split payout (11)', () => {
    it('makes the technician wait until the customer funds escrow, then captures itemized on confirmation', async () => {
      const jobId = await acceptedJob(1_000_000);
      const blocked = await status(jobId, 'en_route');
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('escrow_unfunded');

      const { pay, outcome } = await fundByCard(jobId);
      expect(pay).toMatchObject({ settlement: 'escrow', amountMinor: 1_000_000, provider: 'mock' });
      expect(outcome).toBe('escrow_held');
      expect(scheduler.notifications.find((n) => n.userId === id.tech && n.message.data?.type === 'escrow.funded')?.message.whatsapp).toBe(true);
      expect((await request(app).get(`/v1/jobs/${jobId}/escrow`).set(as('tech'))).body).toMatchObject({ status: 'held', hold: { held_minor: 1_000_000 } });
      // Nothing reaches the technician while it's held.
      expect(await walletOf('tech')).toBe(0);
      const again = await request(app).post(`/v1/jobs/${jobId}/payments`).set(as('cust')).send({ method: 'ussd' });
      expect(again.body.error.code).toBe('already_funded');

      for (const s of ['en_route', 'in_progress', 'completed']) expect((await status(jobId, s)).status).toBe(200);
      const esc = await request(app).get(`/v1/jobs/${jobId}/escrow`).set(as('cust'));
      expect(esc.body.autoReleaseAt).toBeTruthy();

      const confirm = await request(app).post(`/v1/jobs/${jobId}/confirm-completion`).set(as('cust'));
      expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
      expect(confirm.body.job.status).toBe('paid');
      const hold = (await request(app).get(`/v1/jobs/${jobId}/escrow`).set(as('tech'))).body.hold;
      expect(hold).toMatchObject({ status: 'captured', captured_minor: 1_000_000, labor_minor: 1_000_000, parts_base_minor: 0, commission_minor: 180_000, technician_payout_minor: 820_000, released_by: 'customer' });
      expect(await walletOf('tech')).toBe(820_000);
      const earn = await request(app).get('/v1/technicians/me/earnings').set(as('tech'));
      expect(earn.body.earnings[0]).toMatchObject({ jobs_paid: 1, gross_minor: 1_000_000, commission_minor: 180_000, net_minor: 820_000 });
      await review(jobId);
    });

    it('refunds escrow when a funded job is cancelled (wallet-funded goes straight back to the wallet)', async () => {
      await pool.query(`INSERT INTO wallets (user_id, currency, balance_minor) VALUES ($1, 'NGN', 2000000)`, [id.cust2]);
      const jobId = await acceptedJob(500_000, 'cust2');
      const pay = await request(app).post(`/v1/jobs/${jobId}/payments`).set(as('cust2')).send({ method: 'wallet' });
      expect(pay.body).toMatchObject({ status: 'succeeded', settlement: 'escrow', escrow: 'held' });
      expect(await walletOf('cust2')).toBe(1_500_000);
      // Admin can't refund money that's still in escrow through the payment refund endpoint.
      expect((await request(app).post(`/v1/admin/payments/${pay.body.paymentId}/refund`).set(as('admin')).send({})).status).toBe(409);
      expect((await status(jobId, 'cancelled', 'cust2')).status).toBe(200);
      expect(await walletOf('cust2')).toBe(2_000_000);
      expect((await request(app).get(`/v1/jobs/${jobId}/escrow`).set(as('cust2'))).body.status).toBe('refunded');
    });

    it('auto-releases after the confirmation window', async () => {
      const jobId = await acceptedJob(300_000);
      await fundByCard(jobId);
      for (const s of ['en_route', 'in_progress', 'completed']) await status(jobId, s);
      expect(await runEscrowAutoRelease()).toBe(0);
      await pool.query(`UPDATE jobs SET completed_at = now() - interval '49 hours' WHERE id = $1`, [jobId]);
      expect(await runEscrowAutoRelease()).toBe(1);
      const esc = await request(app).get(`/v1/jobs/${jobId}/escrow`).set(as('cust'));
      expect(esc.body.hold).toMatchObject({ status: 'captured', released_by: 'auto', technician_payout_minor: 246_000 });
      await review(jobId);
    });

    it('holds disputed funds until an admin settles; partial capture pro-rates commission and refunds the rest', async () => {
      await pool.query(`UPDATE wallets SET balance_minor = 1000000 WHERE user_id = $1`, [id.cust2]);
      const jobId = await acceptedJob(1_000_000, 'cust2');
      await request(app).post(`/v1/jobs/${jobId}/payments`).set(as('cust2')).send({ method: 'wallet' });
      for (const s of ['en_route', 'in_progress', 'completed']) await status(jobId, s);
      expect((await status(jobId, 'disputed', 'cust2')).status).toBe(200);
      await pool.query(`UPDATE jobs SET completed_at = now() - interval '100 hours' WHERE id = $1`, [jobId]);
      expect(await runEscrowAutoRelease()).toBe(0); // disputes never auto-release
      const techBefore = await walletOf('tech');

      const settled = await request(app).post(`/v1/admin/jobs/${jobId}/escrow/settle`).set(as('admin')).send({ captureMinor: 600_000 });
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect(settled.body.job.status).toBe('paid');
      expect(settled.body.hold).toMatchObject({ captured_minor: 600_000, commission_minor: 108_000, technician_payout_minor: 492_000, refunded_minor: 400_000, released_by: 'admin' });
      expect((await walletOf('tech')) - techBefore).toBe(492_000);
      expect(await walletOf('cust2')).toBe(400_000);
      const held = await request(app).get('/v1/admin/escrow?status=captured').set(as('admin'));
      expect(held.body.holds.length).toBeGreaterThanOrEqual(3);
      await review(jobId, 'cust2');
    });

    it('refunds an instant booking the technician declines after it was funded', async () => {
      const jobId = await acceptedJob(200_000, 'cust2');
      await request(app).post(`/v1/jobs/${jobId}/payments`).set(as('cust2')).send({ method: 'wallet' });
      expect(await walletOf('cust2')).toBe(200_000);
      await pool.query(`UPDATE jobs SET booking_mode = 'instant' WHERE id = $1`, [jobId]);
      const d = await request(app).post(`/v1/jobs/${jobId}/instant/decline`).set(as('tech')).send({});
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body.job).toMatchObject({ status: 'open', escrow_status: 'unfunded' });
      expect(await walletOf('cust2')).toBe(400_000);
    });
  });

  describe('channels, routing and the provider-agnostic layer (11)', () => {
    it('lists card, bank transfer, USSD and wallet', async () => {
      const r = await request(app).get('/v1/payments/options?currency=NGN').set(as('cust'));
      expect(r.body.methods.map((m: { method: string }) => m.method).sort()).toEqual(['bank_transfer', 'card', 'ussd', 'wallet']);
      expect(r.body.virtualAccounts).toBe(true);
    });

    it('falls back to the next gateway in the admin priority when one errors', async () => {
      const originals = { paystack: getRegistration('paystack')!, flutterwave: getRegistration('flutterwave')! };
      const calls: string[] = [];
      const fake = (name: 'paystack' | 'flutterwave', fail: boolean): PaymentProvider =>
        Object.assign(new MockProvider(), {
          name,
          createSplitPayment: async (input: { reference: string }) => {
            calls.push(name);
            if (fail) throw new Error(`${name} is down`);
            return { providerRef: `${name}_${input.reference}`, checkoutUrl: `https://${name}.example/pay` };
          },
        }) as unknown as PaymentProvider;
      registerProvider({ ...originals.paystack, configured: () => true, create: () => fake('paystack', true) });
      registerProvider({ ...originals.flutterwave, configured: () => true, create: () => fake('flutterwave', false) });
      try {
        expect(await gatewayCandidates('NGN', 'card')).toEqual(['paystack', 'flutterwave', 'mock']);
        const t = await request(app).post('/v1/wallet/topups').set(as('cust')).send({ amountMinor: 100_000, currency: 'NGN', method: 'card' });
        expect(t.status, JSON.stringify(t.body)).toBe(201);
        expect(t.body).toMatchObject({ provider: 'flutterwave', checkoutUrl: 'https://flutterwave.example/pay' });
        expect(calls).toEqual(['paystack', 'flutterwave']);

        // Admin re-prioritises Flutterwave for NGN; an explicit choice is honoured.
        await request(app)
          .put('/v1/admin/settings/payment_routing')
          .set(as('admin'))
          .send({ value: { enabledGateways: ['paystack', 'flutterwave'], priority: { NGN: ['flutterwave', 'paystack'], default: ['flutterwave'] }, fallbackOnError: false } });
        expect(await gatewayCandidates('NGN', 'card')).toEqual(['flutterwave']);
        expect(await gatewayCandidates('NGN', 'card', 'paystack')).toEqual(['paystack']);
      } finally {
        registerProvider(originals.paystack);
        registerProvider(originals.flutterwave);
        await pool.query(`DELETE FROM platform_settings WHERE key = 'payment_routing'`);
      }
    });

    it('issues a dedicated virtual account; transfers into it top up the wallet once', async () => {
      const before = await walletOf('cust');
      const created = await request(app).post('/v1/wallet/virtual-account').set(as('cust')).send({ currency: 'NGN' });
      expect(created.status).toBe(201);
      expect(created.body.account).toMatchObject({ provider: 'mock', bank_name: 'Mock Bank' });
      expect((await request(app).post('/v1/wallet/virtual-account').set(as('cust')).send({ currency: 'NGN' })).status).toBe(200);
      const ev = { id: 'evt_va_1', type: 'virtual_account.credited', reference: 'trf_1', accountRef: `mock_va_${id.cust}`, amount: 750_000 };
      expect((await webhook(ev)).body.outcome).toBe('wallet_credited');
      expect((await webhook(ev)).body.outcome).toBe('duplicate');
      expect((await webhook({ ...ev, id: 'evt_va_2', accountRef: 'nobody' })).body.outcome).toBe('unknown_account');
      expect((await walletOf('cust')) - before).toBe(750_000);
    });

    it('sells technician boosts through the same payment layer (gateway → webhook → active)', async () => {
      const p = await request(app).post('/v1/technicians/me/promotions').set(as('tech')).send({ product: 'boost_7d', currency: 'NGN', method: 'ussd' });
      expect(p.status, JSON.stringify(p.body)).toBe(202);
      expect(p.body.purchase.status).toBe('pending');
      const listed = await request(app).get('/v1/technicians/me/promotions').set(as('tech'));
      expect(listed.body.active.boosts).toHaveLength(0);
      expect((await webhook({ id: 'evt_promo', type: 'payment.succeeded', reference: p.body.paymentId, amount: 500_000 })).body.outcome).toBe('promotion_activated');
      const after = await request(app).get('/v1/technicians/me/promotions').set(as('tech'));
      expect(after.body.active.boosts).toHaveLength(1);
      const row = await pool.query('SELECT status FROM promotion_purchases WHERE id = $1', [p.body.purchase.id]);
      expect(row.rows[0].status).toBe('active');
    });
  });

  // ================================================================== Section 12
  describe('Marketplace / Deals advertising module (12)', () => {
    beforeAll(async () => {
      const names = Array.from({ length: 25 }, (_, i) => `Pipe Depot ${String(i).padStart(2, '0')}`);
      for (const n of names) {
        await pool.query(`INSERT INTO spare_parts_sellers (name, city, status, category_ids) VALUES ($1, 'Lagos', 'verified', $2)`, [n, [plumbing]]);
      }
      const r = await pool.query(`INSERT INTO spare_parts_sellers (name, city, status) VALUES ('Shady Parts', 'Lagos', 'provisional') RETURNING id`);
      id.unverifiedSeller = r.rows[0].id;
      id.seller = (await pool.query(`SELECT id FROM spare_parts_sellers WHERE name = 'Pipe Depot 00'`)).rows[0].id;
    });

    it('interleaves at most one sponsored slot per N organic results', () => {
      const organic = Array.from({ length: 25 }, (_, i) => i);
      const out = interleave(organic, ['a', 'b', 'c'], 10);
      expect(out.filter((r) => r.sponsored)).toHaveLength(2);
      expect(out.findIndex((r) => r.sponsored)).toBe(0);
      expect(out.slice(1).findIndex((r) => r.sponsored) + 1).toBe(11);
      expect(interleave([1, 2, 3], ['a'], 10).some((r) => r.sponsored)).toBe(false);
    });

    it('admin uploads campaigns: featured cards only for verified registry sellers, slot price from settings', async () => {
      const bad = await request(app).post('/v1/admin/ads/campaigns').set(as('admin')).send({ title: 'Shady deals', placement: 'featured_seller', sellerId: id.unverifiedSeller, currency: 'NGN' });
      expect(bad.status).toBe(400);
      const featured = await request(app)
        .post('/v1/admin/ads/campaigns')
        .set(as('admin'))
        .send({ title: 'Pipe Depot — 10% off PVC', placement: 'featured_seller', sellerId: id.seller, currency: 'NGN', clickUrl: 'https://pipedepot.example' });
      expect(featured.status, JSON.stringify(featured.body)).toBe(201);
      expect(featured.body.campaign).toMatchObject({ status: 'active', pricing_model: 'flat_daily', rate_minor: 500_000, managed_by_admin: true });
      id.featured = featured.body.campaign.id;
      const brand = await request(app)
        .post('/v1/admin/ads/campaigns')
        .set(as('admin'))
        .send({ title: 'Genuine fittings', placement: 'brand_card', advertiserId: id.adv, currency: 'NGN', targetCategoryIds: [plumbing], clickUrl: 'https://partshub.example' });
      expect(brand.body.campaign).toMatchObject({ pricing_model: 'cpm', rate_minor: 200_000 });
      id.brand = brand.body.campaign.id;
      for (let i = 0; i < 3; i++) {
        const s = await request(app)
          .post('/v1/admin/ads/campaigns')
          .set(as('admin'))
          .send({ title: `Sponsored ${i}`, placement: 'sponsored_search', advertiserId: id.adv, currency: 'NGN', searchKeywords: ['pipe'], clickUrl: 'https://partshub.example' });
        expect(s.body.campaign).toMatchObject({ pricing_model: 'cpc', rate_minor: 5_000 });
        id[`sp${i}`] = s.body.campaign.id;
      }
    });

    it('shows the Deals tab: featured verified sellers and labeled brand cards, billed per model', async () => {
      const r = await request(app).get(`/v1/marketplace/deals?categoryId=${plumbing}`).set(as('cust'));
      expect(r.status).toBe(200);
      expect(r.body.featuredSellers).toEqual([expect.objectContaining({ id: id.featured, seller_name: 'Pipe Depot 00', sponsored: true, label: 'Featured' })]);
      expect(r.body.brandCards).toEqual([expect.objectContaining({ id: id.brand, sponsored: true, label: 'Sponsored' })]);
      expect(r.body.verifiedSellers.length).toBeGreaterThan(0);
      const stats = await pool.query('SELECT campaign_id, impressions, revenue_minor FROM ad_daily_stats');
      const byId = Object.fromEntries(stats.rows.map((s) => [s.campaign_id, s]));
      expect(byId[id.featured!]).toMatchObject({ impressions: 1, revenue_minor: 500_000 }); // flat day rate
      expect(byId[id.brand!]).toMatchObject({ impressions: 1, revenue_minor: 200 }); // ₦2,000 CPM → 1 impression
    });

    it('caps sponsored search results at 1 per 10 organic and labels them', async () => {
      const r = await request(app).get('/v1/marketplace/search?q=pipe').set(as('tech'));
      expect(r.body.organicCount).toBe(25);
      const sponsored = r.body.results.filter((x: { sponsored: boolean }) => x.sponsored);
      expect(sponsored).toHaveLength(2);
      expect(sponsored.every((x: { label: string }) => x.label === 'Sponsored')).toBe(true);
      const few = await request(app).get('/v1/marketplace/search?q=Depot 0').set(as('tech'));
      expect(few.body.organicCount).toBe(10);
      expect(few.body.results.filter((x: { sponsored: boolean }) => x.sponsored)).toHaveLength(0); // "Depot 0" doesn't match the "pipe" keyword
    });

    it('bills clicks on CPC campaigns and reports revenue to admins', async () => {
      const c = await request(app).post(`/v1/marketplace/ads/${id.sp0}/click`).set(as('cust'));
      expect(c.body.clickUrl).toBe('https://partshub.example');
      const row = await pool.query('SELECT clicks, revenue_minor FROM ad_daily_stats WHERE campaign_id = $1', [id.sp0]);
      expect(row.rows[0]).toMatchObject({ clicks: 1, revenue_minor: 5_000 });
      const a = await request(app).get('/v1/admin/ads/analytics').set(as('admin'));
      const search = a.body.byPlacement.find((p: { placement: string }) => p.placement === 'sponsored_search');
      expect(Number(search.clicks)).toBe(1);
      expect(Number(search.revenue_minor)).toBe(5_000);
      expect(a.body.top[0].id).toBe(id.featured);
    });

    it('keeps advertisers admin-managed until self-serve is switched on, then routes submissions through review', async () => {
      const mine = await request(app).get('/v1/advertiser/campaigns').set(as('adv'));
      expect(mine.body.campaigns.length).toBe(4);
      expect(mine.body.selfServe).toBe(false);
      const blocked = await request(app).post('/v1/advertiser/campaigns').set(as('adv')).send({ title: 'My own ad', currency: 'NGN' });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('self_serve_disabled');

      const settings = (await request(app).get('/v1/admin/settings/advertising').set(as('admin'))).body.value;
      await request(app).put('/v1/admin/settings/advertising').set(as('admin')).send({ value: { ...settings, selfServeEnabled: true } });
      const sub = await request(app).post('/v1/advertiser/campaigns').set(as('adv')).send({ title: 'My own ad', currency: 'NGN' });
      expect(sub.status).toBe(201);
      expect(sub.body.campaign).toMatchObject({ status: 'pending_review', managed_by_admin: false });
      const rej = await request(app).post(`/v1/admin/ads/campaigns/${sub.body.campaign.id}/review`).set(as('admin')).send({ decision: 'reject', note: 'Add a landing page' });
      expect(rej.body.campaign).toMatchObject({ status: 'rejected', review_note: 'Add a landing page' });
      const stats = await request(app).get(`/v1/advertiser/campaigns/${id.brand}/stats`).set(as('adv'));
      expect(stats.body.stats[0]).toMatchObject({ impressions: 1 });
      await request(app).put('/v1/admin/settings/advertising').set(as('admin')).send({ value: settings });
    });

    it('switching the module off hides it without touching core flows', async () => {
      const settings = (await request(app).get('/v1/admin/settings/advertising').set(as('admin'))).body.value;
      await request(app).put('/v1/admin/settings/advertising').set(as('admin')).send({ value: { ...settings, enabled: false } });
      try {
        expect((await request(app).get('/v1/marketplace/status').set(as('cust'))).body.enabled).toBe(false);
        const off = await request(app).get('/v1/marketplace/deals').set(as('cust'));
        expect(off.status).toBe(404);
        expect(off.body.error.code).toBe('module_disabled');
        expect((await request(app).get('/v1/marketplace/search?q=pipe').set(as('cust'))).status).toBe(404);
        // Core: a whole booking → escrow → payout cycle still works.
        const jobId = await acceptedJob(100_000);
        await fundByCard(jobId);
        for (const s of ['en_route', 'in_progress', 'completed']) expect((await status(jobId, s)).status).toBe(200);
        expect((await request(app).post(`/v1/jobs/${jobId}/confirm-completion`).set(as('cust'))).body.job.status).toBe('paid');
        expect((await request(app).get('/v1/categories').set(as('cust'))).status).toBe(200);
      } finally {
        await request(app).put('/v1/admin/settings/advertising').set(as('admin')).send({ value: settings });
      }
    });

    it('is a bolt-on: nothing outside the module imports it except the app mount', () => {
      const src = join(__dirname, '../src');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.ts')) files.push(p);
        }
      };
      walk(src);
      const importers = files.filter((f) => !f.includes(join('modules', 'advertising')) && /modules\/advertising/.test(readFileSync(f, 'utf8')));
      expect(importers.map((f) => f.slice(src.length + 1))).toEqual(['app.ts']);
    });
  });
});
