import * as Location from 'expo-location';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { FIREBASE_ENABLED } from './config';
import { firestore } from './firebase';

export interface LivePosition {
  lat: number;
  lng: number;
  heading?: number | null;
}

/**
 * Technician side: streams position to Firestore `liveJobs/{jobId}/positions/latest`
 * while en route. The API grants access per job; see firestore.rules.
 */
export async function startSharingLocation(jobId: string): Promise<() => void> {
  if (!FIREBASE_ENABLED) return () => {};
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Location permission is needed to share your live position');
  const ref = doc(firestore(), 'liveJobs', jobId, 'positions', 'latest');
  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 20 },
    (pos) => {
      void setDoc(ref, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        heading: pos.coords.heading ?? null,
        at: serverTimestamp(),
      });
    },
  );
  return () => sub.remove();
}

/** Customer side: subscribes to the technician's live position. */
export function watchTechnician(jobId: string, onPosition: (p: LivePosition) => void): () => void {
  if (!FIREBASE_ENABLED) return () => {};
  return onSnapshot(doc(firestore(), 'liveJobs', jobId, 'positions', 'latest'), (snap) => {
    const d = snap.data();
    if (d) onPosition({ lat: d.lat, lng: d.lng, heading: d.heading });
  });
}
