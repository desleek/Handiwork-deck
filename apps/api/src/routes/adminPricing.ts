import { priceLine } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { audit } from '../services/audit';
import { refreshQuoteTotals } from '../services/jobs/quotes';
import { allSettings, isSettingKey, setSetting } from '../services/settings';

/** Section 5/5a admin tools: Demand Notice cases, per-technician cap overrides, pricing settings. */
export const adminPricingRouter = Router();
adminPricingRouter.use('/admin', authenticate, requireUser('admin'));

adminPricingRouter.get('/admin/cap-exceptions', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'declined', 'withdrawn']).default('pending') }), req.query);
  const cases = await query(
    `SELECT e.*, j.ref AS job_ref, j.title AS job_title, u.full_name AS technician_name,
            tp.markup_cap_bps_override,
            (SELECT coalesce(json_agg(json_build_object('id', f.id, 'url', f.url, 'contentType', f.content_type)), '[]'::json)
               FROM files f WHERE f.id = ANY(e.evidence_file_ids)) AS evidence,
            (SELECT count(*) FROM cap_exception_requests p WHERE p.technician_id = e.technician_id AND p.status = 'approved')::int AS technician_approved_count,
            (SELECT count(*) FROM cap_exception_requests p WHERE p.technician_id = e.technician_id AND p.status = 'declined')::int AS technician_declined_count
       FROM cap_exception_requests e
       JOIN jobs j ON j.id = e.job_id JOIN users u ON u.id = e.technician_id JOIN technician_profiles tp ON tp.user_id = e.technician_id
      WHERE e.status = $1 ORDER BY e.created_at LIMIT 200`,
    [status],
  );
  res.json({ cases });
});

const DecideBody = z.object({ decision: z.enum(['approve', 'decline']), note: z.string().trim().max(1000).optional() });

/**
 * Approve: the requested markup stands on that line of that quote revision only.
 * Decline: the line's markup is reduced to the cap. Either way, once no Demand
 * Notices remain open the quote goes back to the customer.
 */
adminPricingRouter.post('/admin/cap-exceptions/:id/decide', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(DecideBody, req.body);
  const admin = currentUser(req);
  const result = await tx(async (db) => {
    const e = await one(`SELECT * FROM cap_exception_requests WHERE id = $1 FOR UPDATE`, [id], db);
    if (!e) throw notFound('Cap exception request');
    if (e.status !== 'pending') throw conflict(`Request is already ${e.status}`);
    await db.query('SELECT 1 FROM quotes WHERE id = $1 FOR UPDATE', [e.quote_id]);
    await db.query(`UPDATE cap_exception_requests SET status = $2, admin_note = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [
      id,
      b.decision === 'approve' ? 'approved' : 'declined',
      b.note ?? null,
      admin.id,
    ]);
    if (b.decision === 'decline' && e.quote_item_id) {
      const item = await one('SELECT * FROM quote_items WHERE id = $1', [e.quote_item_id], db);
      if (item) {
        const p = priceLine({ kind: 'material', description: item.description, quantity: Number(item.quantity), unitPriceMinor: Number(item.unit_price_minor), markupBps: e.cap_bps });
        await db.query('UPDATE quote_items SET markup_bps = $2, markup_minor = $3, total_minor = $4 WHERE id = $1', [item.id, p.markupBps, p.markupMinor, p.totalMinor]);
        await refreshQuoteTotals(db, e.quote_id);
      }
    }
    const open = await one<{ n: number }>(`SELECT count(*)::int AS n FROM cap_exception_requests WHERE quote_id = $1 AND status = 'pending'`, [e.quote_id], db);
    let released = false;
    if (!open?.n) {
      const r = await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1 AND status = 'pending_exception'`, [e.quote_id]);
      released = !!r.rowCount;
    }
    await audit(
      e.job_id,
      admin.id,
      b.decision === 'approve' ? 'cap_exception.approved' : 'cap_exception.declined',
      { requestId: id, quoteId: e.quote_id, line: e.line_description, requestedMarkupBps: e.requested_markup_bps, appliedMarkupBps: b.decision === 'approve' ? e.requested_markup_bps : e.cap_bps, note: b.note ?? null },
      db,
    );
    const job = await one('SELECT id, ref, customer_id FROM jobs WHERE id = $1', [e.job_id], db);
    return { e, released, job };
  });
  const verdict = b.decision === 'approve' ? 'approved' : `declined — markup reduced to ${result.e.cap_bps / 100}%`;
  await scheduler().notify(result.e.technician_id, {
    title: 'Cap exception decided',
    body: `Your markup request on "${result.e.line_description}" (#${result.job.ref}) was ${verdict}.${b.note ? ` Note: ${b.note}` : ''}`,
    data: { jobId: result.e.job_id, type: 'cap_exception.decided' },
  });
  if (result.released) {
    await scheduler().notify(result.job.customer_id, { title: 'Quote ready', body: `A quote on #${result.job.ref} has finished review and is ready for you.`, data: { jobId: result.e.job_id, type: 'quote.ready' } });
  }
  res.json({ status: b.decision === 'approve' ? 'approved' : 'declined', quoteReleased: result.released });
});

/** Permanent per-technician markup cap override (separate from single-invoice Demand Notice approvals). */
adminPricingRouter.put('/admin/technicians/:id/markup-cap', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { capBps } = parse(z.object({ capBps: z.number().int().min(0).max(100_000).nullable() }), req.body);
  const row = await one('UPDATE technician_profiles SET markup_cap_bps_override = $2 WHERE user_id = $1 RETURNING user_id, markup_cap_bps_override', [id, capBps]);
  if (!row) throw notFound('Technician');
  res.json({ technicianId: id, markupCapBpsOverride: row.markup_cap_bps_override });
});

adminPricingRouter.get('/admin/settings', async (_req, res) => {
  res.json({ settings: await allSettings() });
});

adminPricingRouter.put('/admin/settings/:key', async (req, res) => {
  const key = String(req.params.key);
  if (!isSettingKey(key)) throw notFound('Setting');
  const { value } = parse(z.object({ value: z.unknown() }), req.body);
  try {
    res.json({ key, value: await setSetting(key, value, currentUser(req).id) });
  } catch (err) {
    if (err instanceof z.ZodError) throw badRequest('Invalid setting value', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    throw err;
  }
});
