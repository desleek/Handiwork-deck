import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { api } from '../../src/api/client';
import { Banner, Button, Card, Divider, Row, Screen, T, Tag } from '../../src/components/ui';
import { bpsToPct, formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

/** Earnings dashboard (Section 4): balance, performance multiplier, what drives it, next tier, promotions. */
export default function Earnings() {
  const t = useTheme();
  const { data, refetch } = useQuery({ queryKey: ['earnings'], queryFn: () => api('/technician/earnings') });

  if (!data) return null;
  const p = data.performance;
  const sign = (bps: number) => (bps > 0 ? '+' : bps < 0 ? '−' : '') + bpsToPct(Math.abs(bps));

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
        {data.boostEligibility.eligible ? (
          <T v="small" muted>Boost your placement or tell nearby customers you're available right now.</T>
        ) : (
          <Banner text={`Promotions unlock at a ${data.boostEligibility.minRating}★ rolling rating, so paid visibility always reflects good work.`} />
        )}
        <Button title="Promote" kind="secondary" disabled={!data.boostEligibility.eligible} onPress={() => router.push('/promote')} />
      </Card>
    </Screen>
  );
}
