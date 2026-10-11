import { Alert, Platform } from 'react-native';
import { api } from '../api/client';

/**
 * Firebase Cloud Messaging for both platforms (Section 14a). Permission is requested just-in-time
 * (after sign-in, with a short rationale), never at first launch.
 */
export async function registerForPush(): Promise<void> {
  const { getMessaging, requestPermission, getToken, AuthorizationStatus, onTokenRefresh } = await import('@react-native-firebase/messaging');
  const messaging = getMessaging();

  const proceed = await new Promise<boolean>((resolve) =>
    Alert.alert('Stay updated on your jobs', 'Get alerts for new quotes, messages and when your technician is on the way.', [
      { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Turn on', onPress: () => resolve(true) },
    ]),
  );
  if (!proceed) return;

  const status = await requestPermission(messaging);
  if (status !== AuthorizationStatus.AUTHORIZED && status !== AuthorizationStatus.PROVISIONAL) return;

  const send = (token: string) => api('/me/devices', { body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } }).catch(() => {});
  await send(await getToken(messaging));
  onTokenRefresh(messaging, send);
}
