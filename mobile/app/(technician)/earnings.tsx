import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { Banner, Button, Card, Divider, Row, Screen, T, Tag } from '../../src/components/ui';
import { bpsToPct, formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

/** Earnings dashboard (Section 4): balance, performance multiplier, what drives it, next tier, promotions. */
export default function Earnings() {
  const t = useTheme();
  const { data, refetch } = useQuery({ queryKey: ['earnings'], queryFn: () => api('/technician/earnings') });
  const profile = useQuery({ queryKey: ['tech-profile'], queryFn: () => api('/technician/profile') });
  const [hours, setHours] = useState(1);

  const boost = useMutation({
    mutationFn: ({ categoryId, kind }: { categoryId: string; kind: 'boost' | 'alert' }) =>
      kind === 'boost'
        ? api('/technician/boosts', { body: { categoryId, hours, channel: 'wallet' } })
        : api('/technician/push-alerts', { body: { categoryId, channel: 'wallet' } }),
    onSuccess: () => {
      Alert.alert('Done', 'Your promotion is live.');
      refetch();
    },
    onError: (e: ApiError) => Alert.alert('Not available', e.message),
  });

  if (!data) return null;
  const p = data.performance;
  const sign = (bps: number) => (bps > 0 ? '+' : bps < 0 ? '−' : '') + bpsToPct(Math.abs(bps));
  const firstCategory = profile.data?.categories?.[0];

  return (
    <Screen>
      <Card>
        <T muted>Available to withdraw</T>
        <T v="title" style={[t.font.money, { fontSize: 30 }]}>{formatMoney(data.balanceMinor)}</T>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="small" muted>Last 30 days</T>
          <T v="small">{formatMoney(Number(data.last_30_days_minor))}</T>
        </Row>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="small" muted>Lifetime</T>
          <T v="small">{formatMoney(Number(data.lifetime_minor))}</T>
        </Row>
      </Card>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">Performance rate</T>
          {p.enabled ? <Tag label={`${sign(p.currentMultiplierBps)} on labor`} tone={p.currentMultiplierBps >= 0 ? 'success' : 'danger'} /> : <Tag label="Starting soon" />}
        </Row>
        <T>Rolling rating: {p.ratingAvg ? Number(p.ratingAvg).toFixed(2) : '—'}★ from {p.ratingCount} reviews</T>
        <T v="small" muted>{p.drivers}. {p.appliesTo}</T>
        <Divider />
        {p.nextTier ? (
          <T>Reach {p.nextTier.ratingNeeded.toFixed(1)}★ to earn {sign(p.nextTier.tier.laborAdjustmentBps)} on labor.</T>
        ) : (
          <T>You're in the top tier. Keep it up!</T>
        )}
        {p.tierBelow ? <T v="small" muted>Falling below {p.tierBelow.dropsBelow.toFixed(1)}★ moves you to {sign(p.tierBelow.tier.laborAdjustmentBps)}.</T> : null}
        {p.nextRecalculationAt ? <T v="small" muted>Next update: {new Date(p.nextRecalculationAt).toLocaleDateString()}</T> : null}
      </Card>

      <Card>
        <T v="heading">Get more customers</T>
        {!data.boostEligibility.eligible ? (
          <Banner text={`Promotions unlock at a ${data.boostEligibility.minRating}★ rolling rating, so paid visibility always reflects good work.`} />
        ) : !firstCategory ? (
          <T muted>Add a service on your profile first.</T>
        ) : (
          <>
            <T muted>Priority placement in {firstCategory.name}, clearly labelled "Promoted".</T>
            <Row>
              {[1, 4, 24].map((h) => (
                <Pressable key={h} onPress={() => setHours(h)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 100, backgroundColor: hours === h ? t.color.primary : t.color.surfaceAlt }}>
                  <T v="small" style={{ color: hours === h ? t.color.primaryText : t.color.text }}>{h}h</T>
                </Pressable>
              ))}
            </Row>
            <Button title={`Boost for ${hours}h (paid from wallet)`} kind="secondary" loading={boost.isPending} onPress={() => boost.mutate({ categoryId: firstCategory.category_id, kind: 'boost' })} />
            <Button title="Send 'I'm available now' alert" kind="secondary" loading={boost.isPending} onPress={() => boost.mutate({ categoryId: firstCategory.category_id, kind: 'alert' })} />
            <T v="tiny" muted>Promotions are a service fee paid through Handiwork-Deck, separate from job commission.</T>
          </>
        )}
      </Card>
    </Screen>
  );
}
