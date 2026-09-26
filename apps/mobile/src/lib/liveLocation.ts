import * as Location from 'expo-location';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { api } from './api';
import { FIREBASE_ENABLED } from './config';
import { firestore } from './firebase';
import { ensureLocationPermission } from './locationPermission';
import { setOnline } from './presence';

export interface LivePosition {
  lat: number;
  lng: number;
  heading?: number | null;
}

export interface Tracking {
  active: boolean;
  status: string;
  technicianOnline?: boolean;
  stale?: boolean;
  position?: { lat: number; lng: number; heading: number | null; recordedAt: string } | null;
  distanceKm?: number;
  etaMinutes?: number;
}

const API_POST_EVERY_MS = 10_000;

/**
 * Technician side, while en route: posts position to the API (source of the
 * customer's ETA) and, when Firebase is configured, streams it to Firestore for
 * instant map updates. Sharing requires being online (Section 9).
 */
export async function startSharingLocation(jobId: string): Promise<() => void> {
  if (!(await ensureLocationPermission('share'))) throw new Error('Location permission is needed to share your live position');
  await setOnline(true);
  const ref = FIREBASE_ENABLED ? doc(firestore(), 'liveJobs', jobId, 'positions', 'latest') : null;
  let lastPost = 0;
  const sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 20 }, (pos) => {
    const { latitude, longitude, heading, speed, accuracy } = pos.coords;
    if (ref) void setDoc(ref, { lat: latitude, lng: longitude, heading: heading ?? null, at: serverTimestamp() });
    if (Date.now() - lastPost >= API_POST_EVERY_MS) {
      lastPost = Date.now();
      void api(`/jobs/${jobId}/location`, { method: 'PUT', body: { lat: latitude, lng: longitude, heading: heading ?? null, speedMps: speed ?? null, accuracyM: accuracy ?? null } }).catch(() => {});
    }
  });
  return () => sub.remove();
}

/** Customer side: realtime position from Firestore (when configured). */
export function watchTechnician(jobId: string, onPosition: (p: LivePosition) => void): () => void {
  if (!FIREBASE_ENABLED) return () => {};
  return onSnapshot(doc(firestore(), 'liveJobs', jobId, 'positions', 'latest'), (snap) => {
    const d = snap.data();
    if (d) onPosition({ lat: d.lat, lng: d.lng, heading: d.heading });
  });
}

/** Customer side: position + ETA from the API, polled. */
export function pollTracking(jobId: string, onTracking: (t: Tracking) => void, everyMs = 10_000): () => void {
  let stopped = false;
  const tick = () =>
    api<Tracking>(`/jobs/${jobId}/tracking`)
      .then((t) => !stopped && onTracking(t))
      .catch(() => {});
  void tick();
  const timer = setInterval(tick, everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
