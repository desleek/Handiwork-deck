import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';

export type FileKind = 'portfolio' | 'receipt' | 'boq' | 'avatar' | 'ad_creative' | 'job_photo' | 'id_document';

export interface UploadTicket {
  driver: 's3' | 'cloudinary';
  storageKey: string;
  /** Where the client uploads the bytes. */
  uploadUrl: string;
  method: 'PUT' | 'POST';
  /** Extra multipart form fields (Cloudinary signed upload). */
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  /** Public/delivery URL once uploaded (private kinds are served via signed URLs later). */
  publicUrl?: string;
}

export interface StorageDriver {
  createUploadTicket(input: { ownerId: string; kind: FileKind; contentType: string }): Promise<UploadTicket>;
}

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

const keyFor = (ownerId: string, kind: FileKind, ext: string) => `${kind}/${ownerId}/${randomUUID()}${ext}`;
const extFor = (contentType: string) =>
  ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' })[
    contentType
  ] ?? '';

/** Direct-to-S3 uploads via short-lived presigned PUT URLs. */
export class S3Storage implements StorageDriver {
  private readonly s3: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.s3 = new S3Client({ region });
  }

  async createUploadTicket({ ownerId, kind, contentType }: Parameters<StorageDriver['createUploadTicket']>[0]) {
    const storageKey = keyFor(ownerId, kind, extFor(contentType));
    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, ContentType: contentType }),
      { expiresIn: 600 },
    );
    return {
      driver: 's3' as const,
      storageKey,
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
      publicUrl: `https://${this.bucket}.s3.amazonaws.com/${storageKey}`,
    };
  }
}

/** Signed direct uploads to Cloudinary (https://cloudinary.com/documentation/signatures). */
export class CloudinaryStorage implements StorageDriver {
  constructor(
    private readonly cloudName: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  sign(params: Record<string, string>): string {
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return createHash('sha1').update(toSign + this.apiSecret).digest('hex');
  }

  async createUploadTicket({ ownerId, kind, contentType }: Parameters<StorageDriver['createUploadTicket']>[0]) {
    const storageKey = keyFor(ownerId, kind, '').replace(/\.$/, '');
    const signed = {
      public_id: storageKey,
      timestamp: String(Math.floor(Date.now() / 1000)),
      // Receipts, BOQs and ID documents should not be publicly listable.
      type: kind === 'id_document' || kind === 'receipt' || kind === 'boq' ? 'authenticated' : 'upload',
    };
    const resourceType = contentType === 'application/pdf' ? 'raw' : 'image';
    return {
      driver: 'cloudinary' as const,
      storageKey,
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.cloudName}/${resourceType}/upload`,
      method: 'POST' as const,
      fields: { ...signed, api_key: this.apiKey, signature: this.sign(signed) },
    };
  }
}

let driver: StorageDriver | undefined;
export function storage(): StorageDriver {
  if (driver) return driver;
  if (env.STORAGE_DRIVER === 'cloudinary') {
    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
      throw new Error('CLOUDINARY_* env vars must be set when STORAGE_DRIVER=cloudinary');
    }
    driver = new CloudinaryStorage(env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET);
  } else {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET must be set when STORAGE_DRIVER=s3');
    driver = new S3Storage(env.S3_BUCKET, env.AWS_REGION);
  }
  return driver;
}
export function setStorageDriver(d: StorageDriver) {
  driver = d;
}
