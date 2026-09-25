import type { UserRole } from '@handiwork/shared';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { one } from '../db/pool';
import { forbidden, unauthorized } from '../lib/errors';
import { firebaseAuth } from '../services/firebase';

export interface AuthIdentity {
  uid: string;
  email?: string;
  phone?: string;
}

export interface AppUser {
  id: string;
  firebase_uid: string;
  role: UserRole;
  full_name: string;
  email: string | null;
  phone_e164: string | null;
  customer_type: string | null;
  company_name: string | null;
  is_active: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthIdentity;
      user?: AppUser;
    }
  }
}

async function verifyToken(token: string): Promise<AuthIdentity> {
  // Dev/test only: `dev:<uid>` (optionally `dev:<uid>:<+phone>`) stands in for a Firebase ID token.
  if (env.AUTH_MODE === 'dev' && env.NODE_ENV !== 'production' && token.startsWith('dev:')) {
    const [, uid, phone] = token.split(':');
    if (!uid) throw unauthorized('Malformed dev token');
    return { uid, phone };
  }
  try {
    const decoded = await firebaseAuth().verifyIdToken(token, true);
    return { uid: decoded.uid, email: decoded.email, phone: decoded.phone_number };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

/** Verifies the bearer token. Loads the app user when one exists (it won't before registration). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  req.auth = await verifyToken(token);
  req.user = await one<AppUser>(
    `SELECT id, firebase_uid, role, full_name, email, phone_e164, customer_type, company_name, is_active
       FROM users WHERE firebase_uid = $1`,
    [req.auth.uid],
  );
  if (req.user && !req.user.is_active) return next(forbidden('Account suspended'));
  next();
}

/** Requires a registered user, optionally restricted to specific roles. */
export function requireUser(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(forbidden('Complete registration first'));
    if (roles.length && !roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}

/** Narrowing helper for handlers mounted behind `requireUser`. */
export function currentUser(req: Request): AppUser {
  if (!req.user) throw forbidden('Complete registration first');
  return req.user;
}
