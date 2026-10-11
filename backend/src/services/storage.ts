import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.ts';
import { badRequest } from '../lib/http.ts';

/**
 * Direct-to-storage uploads (portfolio images, receipts, evidence, ID documents, BOQ files).
 * The API issues a short-lived signed upload; the client uploads the bytes itself, then sends
 * back the resulting URL. Driver: S3 or Cloudinary (or "local" for development).
 */
export type UploadKind = 'portfolio' | 'receipt' | 'evidence' | 'id_document' | 'certification' | 'boq' | 'avatar' | 'ad_creative';

const RULES: Record<UploadKind, { types: string[]; maxBytes: number }> = {
  portfolio: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8e6 },
  avatar: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 4e6 },
  ad_creative: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 4e6 },
  receipt: { types: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10e6 },
  evidence: { types: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10e6 },
  id_document: { types: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10e6 },
  certification: { types: ['image/jpeg', 'image/png', 'application/pdf'], maxBytes: 10e6 },
  boq: {
    types: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    maxBytes: 20e6,
  },
};

export interface SignedUpload {
  method: 'PUT' | 'POST';
  url: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  /** URL to store once the upload succeeds. */
  fileUrl: string;
}

export async function createSignedUpload(userId: string, kind: UploadKind, contentType: string, size: number): Promise<SignedUpload> {
  const rule = RULES[kind];
  if (!rule.types.includes(contentType)) throw badRequest('UPLOAD_TYPE', `${contentType} is not allowed for ${kind}`);
  if (size > rule.maxBytes) throw badRequest('UPLOAD_SIZE', `File too large (max ${rule.maxBytes / 1e6} MB)`);
  const key = `${kind}/${userId}/${randomUUID()}`;

  if (env.STORAGE_DRIVER === 's3') {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = new S3Client({ region: env.AWS_REGION });
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType, ContentLength: size }),
      { expiresIn: 300 },
    );
    return { method: 'PUT', url, headers: { 'Content-Type': contentType }, fileUrl: `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}` };
  }

  if (env.STORAGE_DRIVER === 'cloudinary') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = { folder: `handiwork/${kind}`, public_id: key.split('/').pop()!, timestamp };
    const toSign = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    const signature = createHash('sha1').update(toSign + env.CLOUDINARY_API_SECRET).digest('hex');
    const resource = contentType.startsWith('image/') ? 'image' : 'raw';
    return {
      method: 'POST',
      url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resource}/upload`,
      fields: { ...params, api_key: env.CLOUDINARY_API_KEY ?? '', signature },
      fileUrl: `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/${resource}/upload/handiwork/${kind}/${params.public_id}`,
    };
  }

  return { method: 'PUT', url: `${env.PUBLIC_API_URL}/dev-uploads/${key}`, fileUrl: `${env.PUBLIC_API_URL}/dev-uploads/${key}` };
}
