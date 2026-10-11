import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.ts';
import { one } from '../db/pool.ts';
import { HttpError } from '../lib/http.ts';
import { firebaseApp } from '../services/firebase.ts';

export type Role = 'customer' | 'technician' | 'advertiser' | 'admin';

export interface AuthUser {
  id: string;
  firebaseUid: string | null;
  role: Role;
  status: 'active' | 'restricted' | 'suspended' | 'deleted';
  full_name: string;
  email: string | null;
  phone_e164: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      firebaseUid?: string;
      firebaseClaims?: { email?: string; phone_number?: string };
    }
  }
}

async function verifyToken(req: Request): Promise<{ uid: string; email?: string; phone_number?: string } | null> {
  if (env.AUTH_MODE === 'dev') {
    const devId = req.header('x-dev-user-id');
    return devId ? { uid: `dev:${devId}` } : null;
  }
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const app = await firebaseApp();
  if (!app) throw new HttpError(500, 'AUTH_NOT_CONFIGURED', 'Firebase is not configured');
  const { getAuth } = await import('firebase-admin/auth');
  try {
    const decoded = await getAuth(app).verifyIdToken(header.slice(7), true);
    return { uid: decoded.uid, email: decoded.email, phone_number: decoded.phone_number };
  } catch {
    throw new HttpError(401, 'INVALID_TOKEN', 'Session expired. Please sign in again.');
  }
}

/** Verifies the Firebase ID token and loads the platform user (if registered). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const decoded = await verifyToken(req);
  if (!decoded) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in required'));
  req.firebaseUid = decoded.uid;
  req.firebaseClaims = { email: decoded.email, phone_number: decoded.phone_number };
  const devUserId = env.AUTH_MODE === 'dev' ? decoded.uid.slice(4) : null;
  const user = await one<any>(
    `SELECT id, firebase_uid, role, status, full_name, email, phone_e164 FROM users
      WHERE ${devUserId ? 'id::text = $1' : 'firebase_uid = $1'} AND deleted_at IS NULL`,
    [devUserId ?? decoded.uid],
  );
  if (user) req.user = { ...user, firebaseUid: user.firebase_uid };
  next();
}

/** Requires a registered, non-suspended platform user, optionally with one of the given roles. */
export function requireUser(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(403, 'NOT_REGISTERED', 'Complete registration first'));
    if (req.user.status === 'suspended') {
      // Suspended users may still read their account and file an appeal.
      const allowed = req.path.startsWith('/appeals') || (req.method === 'GET' && req.baseUrl.endsWith('/me'));
      if (!allowed) return next(new HttpError(403, 'SUSPENDED', 'Your account is suspended. You can submit an appeal.'));
    }
    if (roles.length && !roles.includes(req.user.role)) {
      return next(new HttpError(403, 'WRONG_ROLE', `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}
