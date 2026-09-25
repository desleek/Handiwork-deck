import * as Location from 'expo-location';
import { api } from './api';

let timer: ReturnType<typeof setInterval> | null = null;

export const isOnline = () => timer !== null;

/**
 * While a technician is "online", send a position heartbeat every minute so they
 * appear live on customers' discovery map. Survives tab switches (module state).
 */
export async function setOnline(on: boolean): Promise<void> {
  if (!on) {
    if (timer) clearInterval(timer);
    timer = null;
    await api('/technicians/me/presence', { method: 'PUT', body: { online: false } }).catch(() => {});
    return;
  }
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Location permission is needed to appear on the map');
  const beat = async () => {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await api('/technicians/me/presence', { method: 'PUT', body: { online: true, lat: pos.coords.latitude, lng: pos.coords.longitude } });
  };
  await beat();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void beat().catch(() => {}), 60_000);
}
