import { useMutation, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, Linking, Pressable, View } from 'react-native';
import { api, ApiError } from '../../../src/api/client';
import type { JobDetail } from '../../../src/api/types';
import { Button, Card, PlatformIcon, Row, Screen, ScreenHeader, T } from '../../../src/components/ui';
import { formatMoney } from '../../../src/lib/money';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

type Channel = 'card' | 'bank_transfer' | 'ussd' | 'wallet';
const CHANNELS: { id: Channel; title: string; body: string; icon: string }[] = [
  { id: 'card', title: 'Debit card', body: 'Verve, Mastercard or Visa', icon: 'credit-card-outline' },
  { id: 'bank_transfer', title: 'Bank transfer', body: 'Pay into a one-time account number', icon: 'bank-outline' },
  { id: 'ussd', title: 'USSD', body: 'Dial a code. No data needed', icon: 'dialpad' },
  { id: 'wallet', title: 'Wallet', body: 'From your Handiwork-Deck balance', icon: 'wallet-outline' },
];

/**
 * All channels feed the same escrow: funds are held by Handiwork-Deck and only released to the
 * technician when the customer confirms the job is done (Section 11). This is a physical service,
 * so no in-app purchase is used.
 */
export default function Pay() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const job = useQuery({ queryKey: ['job', id], queryFn: () => api<JobDetail>(`/jobs/${id}`) });
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: () => api('/wallet') });
  const [channel, setChannel] = useState<Channel>('card');
  const [checkout, setCheckout] = useState<any>(null);
  const [paid, setPaid] = useState<{ reference: string; channel: Channel } | null>(null);

  const total = job.data?.quote?.totals.totalMinor ?? 0;
  const techFirst = job.data?.technician.name.split(' ')[0] ?? 'The technician';
  const balance = wallet.data?.balanceMinor ?? 0;
  const walletShort = balance < total;

  const settled = (paymentId: string) => {
    setPaid({ reference: paymentId.slice(0, 8).toUpperCase(), channel });
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };
  const poll = async (paymentId: string) => {
    const p = await api(`/payments/${paymentId}`);
    if (p.status === 'held' || p.status === 'captured') settled(paymentId);
    else Alert.alert('Waiting for confirmation', 'We will update your job as soon as the payment is confirmed.');
  };

  const pay = useMutation({
    mutationFn: () => api(`/jobs/${id}/pay`, { body: { channel } }),
    onSuccess: async (p) => {
      if (p.status === 'held') return settled(p.paymentId);
      setCheckout({ ...p.checkout, paymentId: p.paymentId });
      if (p.checkout?.authorizationUrl) {
        await WebBrowser.openAuthSessionAsync(p.checkout.authorizationUrl, 'handiwork://payment-complete');
        poll(p.paymentId);
      }
    },
    onError: (e: ApiError) => Alert.alert('Payment not started', e.message),
  });

  const step = paid ? 1 : 0;
  const footer = paid ? (
    <Button title="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace(`/job/${id}`))} />
  ) : !checkout ? (
    <Button
      title={`Pay ${formatMoney(total)} securely`}
      icon="lock-outline"
      loading={pay.isPending}
      disabled={!total || (channel === 'wallet' && walletShort)}
      onPress={() => pay.mutate()}
    />
  ) : null;

  return (
    <Screen
      edges={['top', 'bottom']}
      header={<ScreenHeader title={paid ? 'Payment held' : `Pay for job #${job.data?.short_code ?? ''}`} />}
      footer={footer}
    >
      {/* Escrow promise */}
      <View style={{ backgroundColor: t.color.hero, borderRadius: t.radius.xl, padding: t.space(5), gap: t.space(4) }}>
        <Row gap={3.5}>
          <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: t.color.accent, alignItems: 'center', justifyContent: 'center' }}>
            <PlatformIcon name="shield-check-outline" size={28} color="#17211C" />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T v="title" color={t.color.heroText} style={[t.font.money, { fontSize: 28, lineHeight: 32 }]}>{formatMoney(total)}</T>
            <T v="small" color={t.color.heroMuted} numberOfLines={1}>
              {paid ? `Held safely for job #${job.data?.short_code}` : `${job.data?.category.name ?? ''} · ${job.data?.technician.name ?? ''}`}
            </T>
          </View>
        </Row>
        <T color={t.color.heroText}>
          {techFirst} is paid <T v="bodyStrong" color={t.color.heroText}>only after you confirm</T> the work is done. If something's wrong, report it and the money stays held until it's sorted.
        </T>
      </View>

      <EscrowSteps current={step} techFirst={techFirst} />

      {paid ? (
        <Card>
          <T v="bodyStrong">Receipt</T>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Reference</T><T selectable>{paid.reference}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Paid with</T><T>{CHANNELS.find((c) => c.id === paid.channel)?.title}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Status</T><T v="bodyStrong" color={t.color.primary}>Held safely</T></Row>
        </Card>
      ) : !checkout ? (
        <View accessibilityRole="radiogroup" style={{ gap: t.space(2.5) }}>
          <T v="heading">Pay with</T>
          {CHANNELS.map((c) => {
            const on = channel === c.id;
            const short = c.id === 'wallet' && walletShort;
            return (
              <Pressable
                key={c.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setChannel(c.id)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: t.space(3), backgroundColor: t.color.surface, borderRadius: t.radius.md, borderWidth: on ? 1.5 : 1, borderColor: on ? t.color.primary : t.color.border, padding: t.space(3.5) }}
              >
                <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? t.color.primary : t.color.borderStrong, alignItems: 'center', justifyContent: 'center' }}>
                  {on ? <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: t.color.primary }} /> : null}
                </View>
                <PlatformIcon name={c.icon} size={22} color={t.color.primary} />
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong">{c.title}</T>
                  <T v="small" muted>{c.id === 'wallet' && wallet.data ? `Balance ${formatMoney(balance)}${short ? ' · not enough' : ''}` : c.body}</T>
                </View>
                {short ? (
                  <Pressable accessibilityRole="link" hitSlop={8} onPress={() => router.push('/(customer)/wallet')}>
                    <T v="smallStrong" color={t.color.primary}>Top up</T>
                  </Pressable>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : checkout.virtualAccount ? (
        <Card tone="selected">
          <T v="heading">Transfer exactly {formatMoney(total)} to:</T>
          <T v="title" selectable style={t.font.money}>{checkout.virtualAccount.accountNumber}</T>
          <T>{checkout.virtualAccount.bankName} · {checkout.virtualAccount.accountName}</T>
          <T v="small" muted>This account number is for this payment only.</T>
          <Button title="I've sent it" onPress={() => poll(checkout.paymentId)} />
        </Card>
      ) : checkout.ussd ? (
        <Card tone="selected">
          <T v="heading">Dial this code</T>
          <T v="title" selectable>{checkout.ussd.code}</T>
          <Button title="Dial now" onPress={() => Linking.openURL(`tel:${encodeURIComponent(checkout.ussd.code)}`)} />
          <Button title="I've completed it" kind="outline" onPress={() => poll(checkout.paymentId)} />
        </Card>
      ) : (
        <Button title="Check payment status" onPress={() => poll(checkout.paymentId)} />
      )}
    </Screen>
  );
}

/** The four escrow stages, with the current one highlighted in marigold. */
function EscrowSteps({ current, techFirst }: { current: number; techFirst: string }) {
  const t = useTheme();
  const steps = [
    { title: 'You pay', sub: `Money goes to Handiwork-Deck, not to ${techFirst}` },
    { title: 'Held safely', sub: `${techFirst} can see it's paid and gets to work` },
    { title: 'Job done', sub: `${techFirst} finishes and marks the job complete` },
    { title: `You confirm, ${techFirst} is paid`, sub: 'Or report a problem and we step in' },
  ];
  return (
    <View accessibilityLabel="How your payment is protected">
      {steps.map((s, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <Row key={s.title} gap={3.5} style={{ alignItems: 'stretch' }}>
            <View style={{ alignItems: 'center', width: 28 }}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  borderWidth: 2,
                  borderColor: done ? t.color.primary : now ? t.color.accent : t.color.borderStrong,
                  backgroundColor: done ? t.color.primaryFill : now ? t.color.accent : t.color.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {done ? <PlatformIcon name="check" size={15} color="#FFFFFF" /> : <T v="smallStrong" color={now ? '#17211C' : t.color.textMuted}>{i + 1}</T>}
              </View>
              {i < steps.length - 1 ? <View style={{ width: 2, flex: 1, minHeight: 16, backgroundColor: done ? t.color.primary : t.color.border }} /> : null}
            </View>
            <View style={{ flex: 1, gap: 2, paddingBottom: t.space(3.5) }}>
              <T v="bodyStrong" color={done || now ? t.color.text : t.color.textMuted}>{s.title}</T>
              <T v="small" muted>{s.sub}</T>
            </View>
          </Row>
        );
      })}
    </View>
  );
}
