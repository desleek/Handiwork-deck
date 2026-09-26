import { API_URL } from './config';

type TokenGetter = () => Promise<string | null>;
let getToken: TokenGetter = async () => null;

export function setTokenGetter(fn: TokenGetter) {
  getToken = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_URL}/v1${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return json as T;
}

/** Uploads a local file (from the image picker) through a signed upload ticket. Returns the file id. */
export async function uploadFile(localUri: string, kind: string, contentType: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await uploadFileDetailed(localUri, kind, contentType, extra)).fileId;
}

export interface UploadResult {
  fileId: string;
  /** Price evidence: the seller it was attributed to, and whether it needs admin review (Section 10). */
  seller?: { id: string; name: string; status: string; needsReview: boolean };
}

export async function uploadFileDetailed(localUri: string, kind: string, contentType: string, extra: Record<string, unknown> = {}): Promise<UploadResult> {
  const { fileId, upload, seller } = await api<{
    fileId: string;
    upload: { uploadUrl: string; method: 'PUT' | 'POST'; headers?: Record<string, string>; fields?: Record<string, string> };
    seller?: UploadResult['seller'];
  }>('/uploads', { body: { kind, contentType, ...extra } });
  const blob = await (await fetch(localUri)).blob();
  if (upload.method === 'PUT') {
    const r = await fetch(upload.uploadUrl, { method: 'PUT', headers: upload.headers, body: blob });
    if (!r.ok) throw new Error('Upload failed');
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.fields ?? {})) form.append(k, v);
    form.append('file', { uri: localUri, type: contentType, name: 'upload' } as unknown as Blob);
    const r = await fetch(upload.uploadUrl, { method: 'POST', body: form });
    if (!r.ok) throw new Error('Upload failed');
    const { secure_url } = await r.json();
    await api(`/uploads/${fileId}/complete`, { body: { url: secure_url } });
  }
  return { fileId, seller };
}
