import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db/pool';
import { forbidden } from '../lib/errors';
import { resolveEvidenceSeller } from '../services/sellers';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { ALLOWED_CONTENT_TYPES, storage } from '../services/storage/index';

export const uploadsRouter = Router();

const UploadBody = z.object({
  kind: z.enum(['portfolio', 'receipt', 'boq', 'avatar', 'ad_creative', 'job_photo', 'id_document', 'price_evidence']),
  contentType: z.enum(ALLOWED_CONTENT_TYPES as [string, ...string[]]),
  /** price_evidence: the registry seller who issued the invoice / price proof… */
  sellerId: z.uuid().optional(),
  /** …or, if they aren't listed yet, their details (the evidence then goes to admin review). */
  newSeller: z
    .object({
      name: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(30).optional(),
      address: z.string().trim().max(300).optional(),
      city: z.string().trim().max(80).optional(),
      registrationNumber: z.string().trim().max(60).optional(),
    })
    .optional(),
});

const KIND_ROLES: Record<z.infer<typeof UploadBody>['kind'], string[]> = {
  portfolio: ['technician'],
  id_document: ['technician'],
  receipt: ['technician', 'customer'],
  boq: ['customer'],
  job_photo: ['customer', 'technician'],
  avatar: ['customer', 'technician', 'advertiser', 'admin'],
  ad_creative: ['advertiser'],
  price_evidence: ['customer'],
};

/**
 * Issues a short-lived direct-upload ticket (S3 presigned PUT or Cloudinary
 * signed POST) and records the file. Bytes never pass through the API.
 */
uploadsRouter.post('/uploads', authenticate, requireUser(), async (req, res) => {
  const b = parse(UploadBody, req.body);
  const user = currentUser(req);
  if (!KIND_ROLES[b.kind].includes(user.role)) throw forbidden(`${user.role} cannot upload ${b.kind} files`);
  // Sections 6c/10: price evidence names its seller. Flagged/removed sellers are refused here;
  // sellers not yet in the registry are recorded as "unlisted" for case-by-case admin review.
  const seller = b.kind === 'price_evidence' ? await resolveEvidenceSeller({ sellerId: b.sellerId, newSeller: b.newSeller, userId: user.id }) : null;
  const ticket = await storage().createUploadTicket({ ownerId: user.id, kind: b.kind, contentType: b.contentType });
  const file = await one(
    `INSERT INTO files (owner_id, kind, driver, storage_key, url, content_type, seller_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [user.id, b.kind, ticket.driver, ticket.storageKey, ticket.publicUrl ?? null, b.contentType, seller?.id ?? null],
  );
  res.status(201).json({
    fileId: file.id,
    upload: ticket,
    ...(seller ? { seller: { id: seller.id, name: seller.name, status: seller.status, needsReview: seller.status === 'unlisted' } } : {}),
  });
});

/** Cloudinary returns the delivery URL only after upload; the client reports it back here. */
uploadsRouter.post('/uploads/:id/complete', authenticate, requireUser(), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { url } = parse(z.object({ url: z.url().optional() }), req.body);
  const file = await one(
    `UPDATE files SET url = COALESCE(url, $3) WHERE id = $1 AND owner_id = $2
       AND ($3::text IS NULL OR $3 LIKE 'https://res.cloudinary.com/%' OR $3 LIKE 'https://%.amazonaws.com/%')
     RETURNING id, kind, url`,
    [id, currentUser(req).id, url ?? null],
  );
  if (!file) throw forbidden('Unknown file or disallowed URL');
  res.json({ file });
});
