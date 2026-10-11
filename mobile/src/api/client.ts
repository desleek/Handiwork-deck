import Constants from 'expo-constants';
import { getIdToken } from '../lib/auth';

const API_URL: string = Constants.expoConfig?.extra?.apiUrl ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Network failures and 5xx are retryable; validation and business-rule errors are not. */
  get retryable() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  const qs = init.query
    ? '?' +
      Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  Object.assign(headers, await getIdToken());

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}${qs}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'You appear to be offline. We will retry when you are back online.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json as T;
}

/** Send raw file bytes to an endpoint (BOQ import). The server identifies the format from the filename. */
export async function apiUpload<T = any>(path: string, file: { uri: string; mimeType: string; name: string }): Promise<T> {
  const blob = await (await fetch(file.uri)).blob();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': file.mimeType || 'application/octet-stream', 'x-filename': file.name, ...(await getIdToken()) },
      body: blob,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'You appear to be offline. Try again when you are back online.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Upload failed (${res.status})`, e.details);
  }
  return json as T;
}

/** Upload a file straight to storage using a signed upload from the API. Returns the stored URL. */
export async function uploadFile(kind: string, file: { uri: string; mimeType: string; size: number; name?: string }): Promise<string> {
  const signed = await api<{ method: 'PUT' | 'POST'; url: string; fields?: Record<string, string>; headers?: Record<string, string>; fileUrl: string }>(
    '/me/uploads',
    { body: { kind, contentType: file.mimeType, size: file.size } },
  );
  if (signed.method === 'PUT') {
    const blob = await (await fetch(file.uri)).blob();
    const r = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: blob });
    if (!r.ok) throw new ApiError(r.status, 'UPLOAD_FAILED', 'Upload failed');
  } else {
    const form = new FormData();
    Object.entries(signed.fields ?? {}).forEach(([k, v]) => form.append(k, v));
    form.append('file', { uri: file.uri, type: file.mimeType, name: file.name ?? 'upload' } as any);
    const r = await fetch(signed.url, { method: 'POST', body: form });
    if (!r.ok) throw new ApiError(r.status, 'UPLOAD_FAILED', 'Upload failed');
  }
  return signed.fileUrl;
}
