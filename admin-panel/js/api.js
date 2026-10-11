// API client for the admin panel. Same origin as the API; auth header supplied by auth.js.
import { authHeaders, onUnauthorized } from './auth.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = (window.HW_CONFIG && window.HW_CONFIG.apiBase) || '';

export async function api(path, { method, body, query } = {}) {
  const qs = query
    ? '?' + Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  const headers = { Accept: 'application/json', ...(await authHeaders()) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${BASE}${path}${qs}`, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error — check your connection.');
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error ?? {};
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json;
}

/** Human-readable error text, including validation details from the API. */
export function errorText(err) {
  if (!(err instanceof ApiError)) return String(err?.message ?? err);
  if (err.code === 'VALIDATION' && err.details?.fieldErrors) {
    const f = Object.entries(err.details.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`);
    return [err.message, ...f].join(' — ');
  }
  return err.message;
}
