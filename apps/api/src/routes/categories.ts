import { LABOR_ONLY_POLICIES, SEGMENT_LABEL, SERVICE_SEGMENTS } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { badRequest } from '../lib/errors';

export const categoriesRouter = Router();

export const CATEGORY_COLUMNS = 'id, slug, name, segment, parent_id, icon, description, is_other, sort_order, is_active';

/** Active taxonomy, grouped into the two supercategories. */
categoriesRouter.get('/categories', async (_req, res) => {
  const categories = await query(
    `SELECT ${CATEGORY_COLUMNS} FROM service_categories WHERE is_active
      ORDER BY segment, is_other, sort_order, name`,
  );
  res.json({
    segments: SERVICE_SEGMENTS.map((key) => ({ key, label: SEGMENT_LABEL[key] })),
    categories,
  });
});

const SuggestionBody = z.object({
  name: z.string().trim().min(3).max(80),
  segment: z.enum(SERVICE_SEGMENTS),
  note: z.string().max(1000).optional(),
  /** Technicians: labor-only declaration for this trade if it's approved. */
  laborOnly: z.enum(LABOR_ONLY_POLICIES).optional(),
});

/** Technicians (or customers) propose a trade that isn't listed; admins approve it into the taxonomy. */
categoriesRouter.post('/categories/suggestions', authenticate, requireUser('technician', 'customer'), async (req, res) => {
  const b = parse(SuggestionBody, req.body);
  const user = currentUser(req);
  if (user.role === 'technician' && !b.laborOnly) throw badRequest('Declare whether you accept labor-only work for this trade (laborOnly)');
  const suggestion = await one(
    'INSERT INTO category_suggestions (name, segment, note, suggested_by, labor_only_policy) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [b.name, b.segment, b.note ?? null, user.id, user.role === 'technician' ? b.laborOnly : null],
  );
  res.status(201).json({ suggestion });
});
