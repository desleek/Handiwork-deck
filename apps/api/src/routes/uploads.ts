import { Router } from 'express';
import { z } from 'zod';
import { one } from '../db/pool';
import { forbidden } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { ALLOWED_CONTENT_TYPES, storage } from '../services/storage/index';

export const uploadsRouter = Router();

const UploadBody = z.object({
  kind: z.enum(['portfolio', 'receipt', 'boq', 'avatar', 'ad_creative', 'job_photo', 'id_document']),
  contentType: z.enum(ALLOWED_CONTENT_TYPES as [string, ...string[]]),
});

const KIND_ROLES: Record<z.infer<typeof UploadBody>['kind'], string[]> = {
  portfolio: ['technician'],
  id_document: ['technician'],
  receipt: ['technician', 'customer'],
  boq: ['customer'],
  job_photo: ['customer', 'technician'],
  avatar: ['customer', 'technician', 'advertiser', 'admin'],
  ad_creative: ['advertiser'],
};

/**
 * Issues a short-lived direct-upload ticket (S3 presigned PUT or Cloudinary
 * signed POST) and records the file. Bytes never pass through the API.
 */
uploadsRouter.post('/uploads', authenticate, requireUser(), async (req, res) => {
  const b = parse(UploadBody, req.body);
  const user = currentUser(req);
  if (!KIND_ROLES[b.kind].includes(user.role)) throw forbidden(`${user.role} cannot upload ${b.kind} files`);
  const ticket = await storage().createUploadTicket({ ownerId: user.id, kind: b.kind, contentType: b.contentType });
  const file = await one(
    `INSERT INTO files (owner_id, kind, driver, storage_key, url, content_type) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [user.id, b.kind, ticket.driver, ticket.storageKey, ticket.publicUrl ?? null, b.contentType],
  );
  res.status(201).json({ fileId: file.id, upload: ticket });
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
