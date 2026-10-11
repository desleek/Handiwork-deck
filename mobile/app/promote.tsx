import { useMutation, useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { api, ApiError } from '../src/api/client';
import { Banner, Button, Card, Divider, Empty, Row, Screen, T, Tag } from '../src/components/ui';
import { formatMoney } from '../src/lib/money';
import { queryClient } from '../src/lib/offline';
import { useTheme } from '../src/theme';

type Channel = 'wallet' | 'card' | 'bank_transfer' | 'ussd';
const STARTS = [
  { id: 'now', label: 'Now' },
  { id: 'evening', label: 'This evening (5pm)' },
  { id: 'tomorrow', label: 'Tomorrow (8am)' },
] as const;

function startTime(id: (typeof STARTS)[number]['id']): Date | undefined {
  const d = new Date();
  if (id === 'evening') {
    d.setHours(17, 0, 0, 0);
    return d > new Date() ? d : undefined;
  }
  if (id === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d;
  }
  return undefined;
}

/**
 * Technician visibility boost & "I'm available now" alert (Section 16). Price, eligibility and
 * limits come from the server, which enforces them again at purchase. Promotions are a service fee
 * paid through the normal payment layer — never an in-app purchase, never on credit.
 */
export default function Promote() {
  const t = useTheme();
  const profile = useQuery({ queryKey: ['tech-profile'], queryFn: () => api('/technician/profile') });
  const categories: any[] = profile.data?.categories ?? [];
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [hours, setHours] = useState(4);
  const [start, setStart] = useState<(typeof STARTS)[number]['id']>('now');
  const [channel, setChannel] = useState<Channel>('wallet');
  const cat = categoryId ?? categories[0]?.category_id;
  const startsAt = startTime(start);

  const quote = useQuery({
    queryKey: ['boost-quote', cat, hours, startsAt?.toISOString()],
    queryFn: () => api('/technician/boosts/quote', { query: { categoryId: cat, hours, startsAt: startsAt?.toISOString() } }),
    enabled: !!cat,
  });
  const history = useQuery({ queryKey: ['boosts'], queryFn: () => api('/technician/boosts') });

  const afterPay = async (p: any) => {
    if (p.payment?.checkout?.authorizationUrl) await WebBrowser.openAuthSessionAsync(p.payment.checkout.authorizationUrl, 'handiwork://payment-complete');
    else if (p.payment?.checkout?.virtualAccount) Alert.alert('Transfer to complete', `${p.payment.checkout.virtualAccount.accountNumber}\n${p.payment.checkout.virtualAccount.bankName}`);
    else if (p.payment?.checkout?.ussd) Alert.alert('Dial to complete', p.payment.checkout.ussd.code);
    ['boosts', 'boost-quote', 'wallet', 'earnings'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  };

  const buyBoost = useMutation({
    mutationFn: () => api('/technician/boosts', { body: { categoryId: cat, hours, startsAt: startsAt?.toISOString(), channel } }),
    onSuccess: afterPay,
    onError: (e: ApiError) => Alert.alert('Boost not purchased', e.message),
  });
  const sendAlert = useMutation({
    mutationFn: () => api('/technician/push-alerts', { body: { categoryId: cat, channel } }),
    onSuccess: afterPay,
    onError: (e: ApiError) => Alert.alert('Alert not sent', e.message),
  });

  const chip = (active: boolean) => ({ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 100, backgroundColor: active ? t.color.primary : t.color.surfaceAlt });
  const chipText = (active: boolean) => ({ color: active ? t.color.primaryText : t.color.text });

  if (!profile.data) return null;
  if (categories.length === 0) return <Screen><Empty title="Add a service first" body="Promotions apply to a service you offer." /></Screen>;
  const q = quote.data;

  return (
    <Screen>
      {q && !q.eligible ? <Banner text={q.reason} /> : null}

      <T v="small" muted>SERVICE</T>
      <Row style={{ flexWrap: 'wrap' }}>
        {categories.map((c) => (
          <Pressable key={c.category_id} onPress={() => setCategoryId(c.category_id)} style={chip(cat === c.category_id)}>
            <T v="small" style={chipText(cat === c.category_id)}>{c.name}</T>
          </Pressable>
        ))}
      </Row>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">Priority placement</T>
          <Tag label="Promoted" tone="promoted" />
        </Row>
        <T v="small" muted>Appear above regular results in this service near you, with a small "Promoted" label so customers know it's paid.</T>
        <T v="small" muted>DURATION</T>
        <Row>
          {[1, 4, 8, 24].map((h) => (
            <Pressable key={h} onPress={() => setHours(h)} style={chip(hours === h)}>
              <T v="small" style={chipText(hours === h)}>{h}h</T>
            </Pressable>
          ))}
        </Row>
        <T v="small" muted>START</T>
        <Row style={{ flexWrap: 'wrap' }}>
          {STARTS.map((s) => (
            <Pressable key={s.id} onPress={() => setStart(s.id)} style={chip(start === s.id)}>
              <T v="small" style={chipText(start === s.id)}>{s.label}</T>
            </Pressable>
          ))}
        </Row>
        {q?.boost.overlapsExistingUntil ? <Banner text={`You already have a boost running until ${new Date(q.boost.overlapsExistingUntil).toLocaleString()}. Pick a later start.`} /> : null}
        <Divider />
        <Row style={{ justifyContent: 'space-between' }}>
          <T muted>{formatMoney(q?.boost.ratePerHourMinor)}/hour × {hours}h</T>
          <T v="heading" style={t.font.money}>{formatMoney(q?.boost.totalMinor)}</T>
        </Row>
        <Button
          title={`Boost for ${formatMoney(q?.boost.totalMinor)}`}
          loading={buyBoost.isPending}
          disabled={!q?.eligible || !q?.boost.totalMinor || !!q?.boost.overlapsExistingUntil}
          onPress={() => buyBoost.mutate()}
        />
      </Card>

      <Card>
        <T v="heading">"I'm available now" alert</T>
        <T v="small" muted>One notification to nearby customers interested in this service, using a standard message with your name, rating and distance. You must be online.</T>
        <Row style={{ justifyContent: 'space-between' }}>
          <T muted>{q ? `${q.alert.remainingToday} of ${q.alert.maxPerDay} left today` : ' '}</T>
          <T v="heading" style={t.font.money}>{formatMoney(q?.alert.feeMinor)}</T>
        </Row>
        <Button title="Send alert" kind="secondary" loading={sendAlert.isPending} disabled={!q?.eligible || q?.alert.remainingToday === 0} onPress={() => sendAlert.mutate()} />
      </Card>

      <T v="small" muted>PAY WITH</T>
      <Row style={{ flexWrap: 'wrap' }}>
        {(['wallet', 'card', 'bank_transfer', 'ussd'] as Channel[]).map((c) => (
          <Pressable key={c} onPress={() => setChannel(c)} style={chip(channel === c)}>
            <T v="small" style={chipText(channel === c)}>{{ wallet: 'Wallet', card: 'Card', bank_transfer: 'Transfer', ussd: 'USSD' }[c]}</T>
          </Pressable>
        ))}
      </Row>
      <T v="tiny" muted>A boost you've paid for runs to its end time. Promotions are a service fee, separate from job commission.</T>

      {(history.data?.boosts?.length ?? 0) + (history.data?.alerts?.length ?? 0) > 0 ? (
        <Card>
          <T v="heading">History</T>
          {history.data.boosts.slice(0, 10).map((b: any) => (
            <View key={b.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="small">Boost · {b.hours}h from {new Date(b.starts_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</T>
                <Tag label={b.status.replace('_', ' ')} tone={b.status === 'active' ? 'success' : 'neutral'} />
              </Row>
            </View>
          ))}
          {history.data.alerts.slice(0, 10).map((a: any) => (
            <Row key={a.id} style={{ justifyContent: 'space-between' }}>
              <T v="small">Alert · {new Date(a.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</T>
              <T v="small" muted>{a.status === 'sent' ? `${a.recipients_count} reached` : a.status.replace('_', ' ')}</T>
            </Row>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
