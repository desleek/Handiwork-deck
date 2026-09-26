import { estimateEtaMinutes } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool';
import { conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { getSetting } from '../services/settings';

/**
 * Section 9: once booked, the customer sees the technician's live en-route
 * position and ETA. Positions are only accepted while the technician is online
 * and the job is en route, and are discarded once they arrive or go offline.
 */
export const trackingRouter = Router();

/** In-app location disclosure accepted (shown before the OS permission prompt). */
trackingRouter.post('/me/location-disclosure', authenticate, requireUser(), async (req, res) => {
  await query('UPDATE users SET location_disclosure_accepted_at = COALESCE(location_disclosure_accepted_at, now()) WHERE id = $1', [currentUser(req).id]);
  res.status(204).end();
});

const Position = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).nullable().optional(),
  speedMps: z.number().min(0).max(100).nullable().optional(),
  accuracyM: z.number().min(0).max(10_000).nullable().optional(),
});

trackingRouter.put('/jobs/:id/location', authenticate, requireUser('technician'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const p = parse(Position, req.body);
  const tech = currentUser(req);
  const t = await one(
    `SELECT j.status, j.technician_id, tp.live_at, u.location_disclosure_accepted_at
       FROM jobs j JOIN technician_profiles tp ON tp.user_id = $2 JOIN users u ON u.id = $2 WHERE j.id = $1`,
    [jobId, tech.id],
  );
  if (!t) throw notFound('Job');
  if (t.technician_id !== tech.id) throw forbidden('Not your job');
  if (t.status !== 'en_route') throw conflict('Live tracking is only shared while you are en route');
  if (!t.location_disclosure_accepted_at) throw new HttpError(409, 'Accept the location disclosure first', 'disclosure_required');
  if (!t.live_at) throw new HttpError(409, 'Go online to share your location', 'offline');
  await query(
    `INSERT INTO job_tracking (job_id, technician_id, lat, lng, heading, speed_mps, accuracy_m, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (job_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, heading = EXCLUDED.heading,
       speed_mps = EXCLUDED.speed_mps, accuracy_m = EXCLUDED.accuracy_m, recorded_at = now()`,
    [jobId, tech.id, p.lat, p.lng, p.heading ?? null, p.speedMps ?? null, p.accuracyM ?? null],
  );
  // Also keeps their "online" presence fresh for the discovery map.
  await query('UPDATE technician_profiles SET live_lat = $2, live_lng = $3, live_at = now() WHERE user_id = $1', [tech.id, p.lat, p.lng]);
  res.status(204).end();
});

trackingRouter.get('/jobs/:id/tracking', authenticate, requireUser(), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const user = currentUser(req);
  const job = await one('SELECT id, status, lat, lng, customer_id, technician_id FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw notFound('Job');
  if (job.customer_id !== user.id && job.technician_id !== user.id && user.role !== 'admin') throw notFound('Job');
  if (job.status !== 'en_route') {
    res.json({ active: false, status: job.status });
    return;
  }
  const cfg = await getSetting('tracking');
  const t = await one(
    `SELECT jt.*, tp.live_at IS NOT NULL AS online FROM job_tracking jt JOIN technician_profiles tp ON tp.user_id = jt.technician_id WHERE jt.job_id = $1`,
    [jobId],
  );
  if (!t) {
    res.json({ active: true, status: job.status, position: null, technicianOnline: false });
    return;
  }
  const ageMin = (Date.now() - new Date(t.recorded_at).getTime()) / 60_000;
  const eta = estimateEtaMinutes({ lat: t.lat, lng: t.lng }, { lat: job.lat, lng: job.lng }, { speedMps: t.speed_mps, ...cfg });
  res.json({
    active: true,
    status: job.status,
    technicianOnline: t.online,
    stale: ageMin > cfg.staleAfterMinutes,
    position: { lat: t.lat, lng: t.lng, heading: t.heading, recordedAt: t.recorded_at },
    ...eta,
  });
});
