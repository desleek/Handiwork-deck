import * as WebBrowser from 'expo-web-browser';
import { Alert, Linking } from 'react-native';
import { api } from '../api/client';

export type PayChannel = 'wallet' | 'card' | 'bank_transfer' | 'ussd';
export const CHANNEL_LABELS: Record<PayChannel, string> = {
  wallet: 'Wallet',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  ussd: 'USSD',
};
const ORDER: PayChannel[] = ['wallet', 'card', 'bank_transfer', 'ussd'];

/** Ask how to pay using the platform choice sheet (ActionSheet on iOS, bottom sheet on Android). */
export async function chooseChannel(open: (title: string, options: string[]) => Promise<number | null>, title = 'Pay with'): Promise<PayChannel | null> {
  const i = await open(title, ORDER.map((c) => CHANNEL_LABELS[c]));
  return i === null ? null : ORDER[i];
}

/**
 * Finish any payment started through the shared payment layer: wallet settles immediately,
 * card opens the hosted checkout, transfer/USSD show the details. Returns true once settled.
 */
export async function completeCheckout(p: { paymentId: string; status: string; checkout?: any }): Promise<boolean> {
  if (p.status === 'held' || p.status === 'captured') return true;
  const c = p.checkout ?? {};
  if (c.authorizationUrl) {
    await WebBrowser.openAuthSessionAsync(c.authorizationUrl, 'handiwork://payment-complete');
  } else if (c.virtualAccount) {
    await new Promise<void>((resolve) =>
      Alert.alert('Transfer to complete payment', `${c.virtualAccount.accountNumber}\n${c.virtualAccount.bankName}\n${c.virtualAccount.accountName}`, [{ text: "I've sent it", onPress: () => resolve() }]),
    );
  } else if (c.ussd) {
    await new Promise<void>((resolve) =>
      Alert.alert('Dial to complete payment', c.ussd.code, [
        { text: 'Dial', onPress: () => { Linking.openURL(`tel:${encodeURIComponent(c.ussd.code)}`); resolve(); } },
        { text: 'Done', onPress: () => resolve() },
      ]),
    );
  }
  const status = await api(`/payments/${p.paymentId}`).catch(() => null);
  return status?.status === 'held' || status?.status === 'captured';
}
