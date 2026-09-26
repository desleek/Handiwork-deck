import * as Location from 'expo-location';
import { api } from './api';
import { ensureLocationPermission } from './locationPermission';

let timer: ReturnType<typeof setInterval> | null = null;

export const isOnline = () => timer !== null;

/**
 * While a technician is "online", send a position heartbeat every minute so they
 * appear live on customers' discovery map. Survives tab switches (module state).
 * Section 9: location is only collected while online, in the foreground.
 */
export async function setOnline(on: boolean): Promise<void> {
  if (!on) {
    if (timer) clearInterval(timer);
    timer = null;
    await api('/technicians/me/presence', { method: 'PUT', body: { online: false } }).catch(() => {});
    return;
  }
  if (!(await ensureLocationPermission('share'))) throw new Error('Location permission is needed to go online');
  const beat = async () => {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await api('/technicians/me/presence', { method: 'PUT', body: { online: true, lat: pos.coords.latitude, lng: pos.coords.longitude } });
  };
  await beat();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void beat().catch(() => {}), 60_000);
}
