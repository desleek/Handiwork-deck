import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Alert, Linking, Platform } from 'react-native';
import { api } from '../api/client';

/**
 * Live location (Section 9). Technicians broadcast only while toggled "online".
 * Foreground permission first; background permission is requested just-in-time, only when a
 * technician goes online, with a rationale shown before the system prompt (Section 14a).
 */
export const LOCATION_TASK = 'hw-technician-location';

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const last = locations[locations.length - 1];
  if (!last) return;
  try {
    await api('/technician/location', { body: { lat: last.coords.latitude, lng: last.coords.longitude, heading: last.coords.heading ?? undefined } });
  } catch {
    // Offline or went offline; the next fix will try again.
  }
});

function explain(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', onPress: () => resolve(true) },
    ]),
  );
}

export async function ensureForegroundLocation(reason: string): Promise<boolean> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) {
    Alert.alert('Location is off', 'Enable location for Handiwork-Deck in Settings.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Settings', onPress: () => Linking.openSettings() },
    ]);
    return false;
  }
  if (!(await explain('Use your location?', reason))) return false;
  return (await Location.requestForegroundPermissionsAsync()).granted;
}

export async function currentPosition() {
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: pos.coords.latitude, lng: pos.coords.longitude };
}

/** Technician goes online: start sharing location (background-capable while online/en route). */
export async function startBroadcasting(): Promise<{ lat: number; lng: number } | null> {
  if (!(await ensureForegroundLocation('Customers nearby can see you on the map while you are online. Sharing stops as soon as you go offline.'))) {
    return null;
  }
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && bg.canAskAgain) {
    const ok = await explain(
      'Keep sharing on the way to jobs?',
      Platform.OS === 'ios'
        ? 'Choose "Always" so customers can see your ETA when the app is in the background. This only happens while you are online.'
        : 'Allow "all the time" so customers can see your ETA when the app is in the background. This only happens while you are online.',
    );
    if (ok) await Location.requestBackgroundPermissionsAsync();
  }
  const pos = await currentPosition();
  const canBackground = (await Location.getBackgroundPermissionsAsync()).granted;
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 50,
      timeInterval: 30_000,
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: !canBackground,
      foregroundService: {
        notificationTitle: 'You are online',
        notificationBody: 'Sharing your location with customers until you go offline.',
      },
    });
  }
  return pos;
}

export async function stopBroadcasting() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}
