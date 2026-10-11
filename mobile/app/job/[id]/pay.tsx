import { useMutation, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, Linking, Pressable } from 'react-native';
import { api, ApiError } from '../../../src/api/client';
import type { JobDetail } from '../../../src/api/types';
import { Banner, Button, Card, PlatformIcon, Row, Screen, T } from '../../../src/components/ui';
import { formatMoney } from '../../../src/lib/money';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

type Channel = 'card' | 'bank_transfer' | 'ussd' | 'wallet';
const CHANNELS: { id: Channel; title: string; body: string; icon: string }[] = [
  { id: 'wallet', title: 'Wallet', body: 'Instant, from your Handiwork-Deck balance', icon: 'wallet-outline' },
  { id: 'card', title: 'Card', body: 'Debit or credit card (Paystack / Flutterwave)', icon: 'credit-card-outline' },
  { id: 'bank_transfer', title: 'Bank transfer', body: 'Pay into a one-time account number', icon: 'bank-outline' },
  { id: 'ussd', title: 'USSD', body: 'Dial a code from your phone — no data needed', icon: 'dialpad' },
];

/**
 * All channels feed the same escrow: funds are held by Handiwork-Deck and only released to the
 * technician when you confirm the job is done (Section 11). This is a physical service, so no
 * in-app purchase is used.
 */
export default function Pay() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const job = queryClient.getQueryData<JobDetail>(['job', id]);
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: () => api('/wallet') });
  const [channel, setChannel] = useState<Channel>('card');
  const [checkout, setCheckout] = useState<any>(null);

  const total = job?.quote?.totals.totalMinor ?? 0;
  const walletShort = channel === 'wallet' && (wallet.data?.balanceMinor ?? 0) < total;

  const pay = useMutation({
    mutationFn: () => api(`/jobs/${id}/pay`, { body: { channel } }),
    onSuccess: async (p) => {
      if (p.status === 'held') return done();
      setCheckout({ ...p.checkout, paymentId: p.paymentId });
      if (p.checkout?.authorizationUrl) {
        await WebBrowser.openAuthSessionAsync(p.checkout.authorizationUrl, 'handiwork://payment-complete');
        poll(p.paymentId);
      }
    },
    onError: (e: ApiError) => Alert.alert('Payment not started', e.message),
  });

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['wallet'] });
    router.back();
  };
  const poll = async (paymentId: string) => {
    const p = await api(`/payments/${paymentId}`);
    if (p.status === 'held' || p.status === 'captured') done();
    else Alert.alert('Waiting for confirmation', 'We will update your job as soon as the payment is confirmed.');
  };

  return (
    <Screen>
      <Card>
        <T muted>Amount</T>
        <T v="title" style={t.font.money}>{formatMoney(total)}</T>
        <T v="small" muted>Held securely until you confirm the job is complete.</T>
      </Card>

      {!checkout ? (
        <>
          {CHANNELS.map((c) => (
            <Pressable key={c.id} onPress={() => setChannel(c.id)}>
              <Card style={{ borderWidth: 2, borderColor: channel === c.id ? t.color.primary : 'transparent' }}>
                <Row>
                  <PlatformIcon name={c.icon} color={t.color.primary} />
                  <T v="heading" style={{ flex: 1 }}>{c.title}</T>
                  {c.id === 'wallet' && wallet.data ? <T muted>{formatMoney(wallet.data.balanceMinor)}</T> : null}
                </Row>
                <T v="small" muted>{c.body}</T>
              </Card>
            </Pressable>
          ))}
          {walletShort ? <Banner text="Your wallet balance is too low. Top up or choose another method." /> : null}
          <Button title={`Pay ${formatMoney(total)}`} loading={pay.isPending} disabled={walletShort} onPress={() => pay.mutate()} />
        </>
      ) : checkout.virtualAccount ? (
        <Card>
          <T v="heading">Transfer exactly {formatMoney(total)} to:</T>
          <T v="title" selectable>{checkout.virtualAccount.accountNumber}</T>
          <T>{checkout.virtualAccount.bankName} · {checkout.virtualAccount.accountName}</T>
          <T v="small" muted>This account number is for this payment only.</T>
          <Button title="I've sent it" onPress={() => poll(checkout.paymentId)} />
        </Card>
      ) : checkout.ussd ? (
        <Card>
          <T v="heading">Dial this code</T>
          <T v="title" selectable>{checkout.ussd.code}</T>
          <Button title="Dial now" onPress={() => Linking.openURL(`tel:${encodeURIComponent(checkout.ussd.code)}`)} />
          <Button title="I've completed it" kind="secondary" onPress={() => poll(checkout.paymentId)} />
        </Card>
      ) : (
        <Button title="Check payment status" onPress={() => poll(checkout.paymentId)} />
      )}
    </Screen>
  );
}

