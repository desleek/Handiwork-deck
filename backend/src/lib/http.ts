import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type infer as ZInfer } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new HttpError(400, code, msg, details);
export const forbidden = (code: string, msg: string, details?: unknown) => new HttpError(403, code, msg, details);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new HttpError(409, code, msg, details);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): ZInfer<S> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid request', details: err.flatten() } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Postgres unique / check violations surface as 409/400 rather than 500
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23505') return res.status(409).json({ error: { code: 'DUPLICATE', message: 'Already exists' } });
  if (pgCode === '23514') return res.status(400).json({ error: { code: 'CONSTRAINT', message: (err as Error).message } });
  (req as any).log?.error?.({ err }, 'unhandled error');
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
