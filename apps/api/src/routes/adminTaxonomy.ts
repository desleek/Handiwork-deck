import { SERVICE_SEGMENTS } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { findMatchingTechnicians } from '../services/matching';
import { CATEGORY_COLUMNS } from './categories';

/** Section 2: the service taxonomy is managed here, not in code. */
export const adminTaxonomyRouter = Router();
adminTaxonomyRouter.use('/admin', authenticate, requireUser('admin'));

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

adminTaxonomyRouter.get('/admin/categories', async (_req, res) => {
  const categories = await query(
    `SELECT ${CATEGORY_COLUMNS},
            (SELECT count(*) FROM technician_services ts WHERE ts.category_id = c.id)::int AS technician_count,
            (SELECT count(*) FROM jobs j WHERE j.category_id = c.id)::int AS job_count
       FROM service_categories c ORDER BY segment, is_other, sort_order, name`,
  );
  res.json({ categories });
});

const CategoryBody = z.object({
  name: z.string().trim().min(2).max(80),
  segment: z.enum(SERVICE_SEGMENTS),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60)
    .optional(),
  icon: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  parentId: z.number().int().positive().nullable().optional(),
  isOther: z.boolean().optional(),
});

adminTaxonomyRouter.post('/admin/categories', async (req, res) => {
  const b = parse(CategoryBody, req.body);
  const category = await one(
    `INSERT INTO service_categories (slug, name, segment, icon, description, sort_order, parent_id, is_other)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT coalesce(max(sort_order), 0) + 1 FROM service_categories WHERE segment = $3)), $7, $8)
     RETURNING ${CATEGORY_COLUMNS}`,
    [b.slug ?? slugify(b.name), b.name, b.segment, b.icon ?? null, b.description ?? null, b.sortOrder ?? null, b.parentId ?? null, b.isOther ?? false],
  );
  res.status(201).json({ category });
});

const CategoryPatch = CategoryBody.omit({ slug: true }).partial().extend({ isActive: z.boolean().optional() });

/** Edit or deactivate. Deactivated categories disappear from discovery and new bookings; existing jobs keep them. */
adminTaxonomyRouter.patch('/admin/categories/:id', async (req, res) => {
  const id = parse(z.coerce.number().int().positive(), req.params.id);
  const b = parse(CategoryPatch, req.body);
  const category = await one(
    `UPDATE service_categories SET
       name = COALESCE($2, name), segment = COALESCE($3, segment), icon = COALESCE($4, icon),
       description = COALESCE($5, description), sort_order = COALESCE($6, sort_order),
       parent_id = CASE WHEN $7 THEN $8 ELSE parent_id END,
       is_other = COALESCE($9, is_other), is_active = COALESCE($10, is_active)
     WHERE id = $1 RETURNING ${CATEGORY_COLUMNS}`,
    [id, b.name ?? null, b.segment ?? null, b.icon ?? null, b.description ?? null, b.sortOrder ?? null, b.parentId !== undefined, b.parentId ?? null, b.isOther ?? null, b.isActive ?? null],
  );
  if (!category) throw notFound('Category');
  res.json({ category });
});

adminTaxonomyRouter.get('/admin/category-suggestions', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }), req.query);
  const suggestions = await query(
    `SELECT s.*, u.full_name AS suggested_by_name, u.role AS suggested_by_role, j.ref AS job_ref
       FROM category_suggestions s JOIN users u ON u.id = s.suggested_by LEFT JOIN jobs j ON j.id = s.job_id
      WHERE s.status = $1 ORDER BY s.created_at LIMIT 200`,
    [status],
  );
  res.json({ suggestions });
});

const ApproveBody = z.object({
  /** Map onto an existing category instead of creating a new one. */
  existingCategoryId: z.number().int().positive().optional(),
  name: z.string().trim().min(2).max(80).optional(),
  segment: z.enum(SERVICE_SEGMENTS).optional(),
  icon: z.string().max(40).optional(),
});

/**
 * Approves an "Other/custom" suggestion. The linked job (if any) is moved into the
 * approved category and released to matching; a suggesting technician gets the
 * service added to their profile.
 */
adminTaxonomyRouter.post('/admin/category-suggestions/:id/approve', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(ApproveBody, req.body);
  const admin = currentUser(req);
  const { category, job } = await tx(async (db) => {
    const s = await one(`SELECT s.*, u.role AS suggested_by_role FROM category_suggestions s JOIN users u ON u.id = s.suggested_by WHERE s.id = $1 FOR UPDATE OF s`, [id], db);
    if (!s) throw notFound('Suggestion');
    if (s.status !== 'pending') throw conflict('Suggestion already reviewed');
    const category = b.existingCategoryId
      ? await one(`SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE id = $1`, [b.existingCategoryId], db)
      : await one(
          `INSERT INTO service_categories (slug, name, segment, icon, sort_order)
           VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM service_categories WHERE segment = $3))
           ON CONFLICT (slug) DO UPDATE SET is_active = true RETURNING ${CATEGORY_COLUMNS}`,
          [slugify(b.name ?? s.name), b.name ?? s.name, b.segment ?? s.segment, b.icon ?? 'construct'],
          db,
        );
    if (!category) throw notFound('Category');
    await db.query(
      `UPDATE category_suggestions SET status = 'approved', resolved_category_id = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`,
      [id, category.id, admin.id],
    );
    if (s.suggested_by_role === 'technician') {
      const policy = s.labor_only_policy ?? 'decline';
      const added = await db.query(
        'INSERT INTO technician_services (technician_id, category_id, labor_only_policy) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [s.suggested_by, category.id, policy],
      );
      if (added.rowCount) {
        await db.query('INSERT INTO technician_labor_only_declarations (technician_id, category_id, policy) VALUES ($1, $2, $3)', [s.suggested_by, category.id, policy]);
      }
    }
    let job = null;
    if (s.job_id) {
      job = await one(
        `UPDATE jobs SET category_id = $2, awaiting_category_review = false WHERE id = $1 AND awaiting_category_review RETURNING *`,
        [s.job_id, category.id],
        db,
      );
    }
    return { category, job };
  });
  if (job) await releaseJobToMatching(job, `Your request "${job.custom_service_name}" was approved as ${category.name}.`);
  res.json({ category });
});

adminTaxonomyRouter.post('/admin/category-suggestions/:id/reject', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { reason } = parse(z.object({ reason: z.string().max(500).optional() }), req.body);
  const { job } = await tx(async (db) => {
    const s = await one(
      `UPDATE category_suggestions SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), note = COALESCE($3, note)
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, currentUser(req).id, reason ?? null],
      db,
    );
    if (!s) throw conflict('Suggestion not found or already reviewed');
    // The job still goes out, under the generic "Other" category.
    const job = s.job_id
      ? await one('UPDATE jobs SET awaiting_category_review = false WHERE id = $1 AND awaiting_category_review RETURNING *', [s.job_id], db)
      : null;
    return { job };
  });
  if (job) await releaseJobToMatching(job, 'Your job has been sent to technicians under "Other".');
  res.json({ ok: true });
});

async function releaseJobToMatching(job: any, customerMessage: string) {
  const matches = await findMatchingTechnicians(job, Number(job.match_radius_km));
  await Promise.all(
    matches.map((t) =>
      scheduler().notify(t.user_id, { title: 'New job near you', body: job.title, data: { jobId: job.id, type: 'job.new' } }),
    ),
  );
  await scheduler().notify(job.customer_id, { title: 'Job approved', body: customerMessage, data: { jobId: job.id, type: 'job.approved' } });
}

// ---------------------------------------------------------------- boosts (priority placement)
const BoostBody = z.object({
  technicianId: z.uuid(),
  categoryId: z.number().int().positive().optional(),
  days: z.number().int().min(1).max(365),
  priority: z.number().int().min(0).max(100).default(0),
});

adminTaxonomyRouter.post('/admin/boosts', async (req, res) => {
  const b = parse(BoostBody, req.body);
  const boost = await one(
    `INSERT INTO technician_boosts (technician_id, category_id, priority, ends_at, created_by)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5) RETURNING *`,
    [b.technicianId, b.categoryId ?? null, b.priority, b.days, currentUser(req).id],
  );
  res.status(201).json({ boost });
});

adminTaxonomyRouter.get('/admin/boosts', async (_req, res) => {
  const boosts = await query(
    `SELECT b.*, u.full_name, c.name AS category_name FROM technician_boosts b
       JOIN users u ON u.id = b.technician_id LEFT JOIN service_categories c ON c.id = b.category_id
      WHERE b.ends_at > now() ORDER BY b.priority DESC, b.ends_at`,
  );
  res.json({ boosts });
});

adminTaxonomyRouter.delete('/admin/boosts/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const row = await one('UPDATE technician_boosts SET ends_at = greatest(starts_at + interval \'1 second\', now()) WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Boost');
  res.status(204).end();
});

adminTaxonomyRouter.post('/admin/certifications/:id/verify', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { verified } = parse(z.object({ verified: z.boolean().default(true) }), req.body);
  const cert = await one('UPDATE technician_certifications SET is_verified = $2 WHERE id = $1 RETURNING *', [id, verified]);
  if (!cert) throw notFound('Certification');
  res.json({ certification: cert });
});
