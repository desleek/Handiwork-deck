import * as Location from 'expo-location';
import { Alert } from 'react-native';
import { api } from './api';

/**
 * Section 9: an in-app disclosure is shown before the OS location prompt (Google
 * Play's prominent-disclosure rule; also good practice on iOS). Location is only
 * used in the foreground and, for technicians, only while they're online.
 */
export type LocationPurpose = 'find' | 'share';

const DISCLOSURE: Record<LocationPurpose, { title: string; body: string }> = {
  find: {
    title: 'Use your location?',
    body:
      'HANDIWORK-DECK uses your location to show technicians near you and to set where the job is. ' +
      "It's only used while you're using the app and isn't shared with technicians until you book.",
  },
  share: {
    title: 'Share your location while online',
    body:
      "While you're online, HANDIWORK-DECK collects your location to show you on customers' maps. " +
      "When you're on the way to a booked job, it's shared live with that customer to show your ETA. " +
      'Collection stops when you go offline or arrive, and it is never collected in the background.',
  },
};

let accepted = false;
export function setDisclosureAccepted(v: boolean) {
  accepted = v;
}

function confirm(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, body, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ]),
  );
}

/** Shows the disclosure (once), records consent with the API, then asks the OS. */
export async function ensureLocationPermission(purpose: LocationPurpose): Promise<boolean> {
  if (!accepted) {
    const d = DISCLOSURE[purpose];
    if (!(await confirm(d.title, d.body))) return false;
    await api('/me/location-disclosure', { method: 'POST' });
    accepted = true;
  }
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return true;
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}
