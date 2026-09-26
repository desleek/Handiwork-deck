import { toMinor } from '@handiwork/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Dashboard {
  earnings: {
    currency: string;
    jobs_paid: number;
    gross_minor: number;
    commission_minor: number;
    net_minor: number;
    labor_minor: number;
    parts_reimbursed_minor: number;
    markup_minor: number;
    net_this_month_minor: number;
  }[];
  pending: { currency: string; jobs: number; amount_minor: number }[];
  wallet: { currency: string; balance_minor: number }[];
  payouts: { id: string; currency: string; amount_minor: number; fee_minor: number; net_minor: number; speed: string; status: string; scheduled_for: string; failure_reason: string | null }[];
  promotions: { boosts: { id: string; category_name: string | null; ends_at: string }[]; alerts: { id: string; radius_factor: number; ends_at: string }[] };
  performance: {
    current: { multiplier: number; adjustmentBps: number; tierStars: number | null; reasons: string[] };
    rollingRating: number | null;
    ratingCount: number;
    projected: { stars: number | null; adjustmentBps: number };
    next: { stars: number; minRating: number; adjustmentBps: number } | null;
    ratingNeeded: number | null;
    tiers: { stars: number; minRating: number; adjustmentBps: number }[];
    lastCalculatedAt: string | null;
    nextRecalculationAt: string | null;
    cycleDays: number;
    adminOverride: boolean;
    heldForReview: boolean;
    stats: { completedJobs: number; technicianCancellations: number; disputes: number };
  };
}
interface Promotions {
  products: { key: string; kind: 'boost' | 'alerts'; label: string; days: number; priceMinor: number }[];
  eligibility: { eligible: boolean; reasons: string[] };
}

const signed = (bps: number) => `${bps > 0 ? '+' : ''}${bps / 100}%`;

/** Section 4 earnings dashboard. */
export default function Earnings() {
  const { data, error, loading, reload } = useApi<Dashboard>('/technicians/me/earnings');
  const currency = data?.wallet[0]?.currency ?? data?.earnings[0]?.currency ?? 'NGN';
  const promos = useApi<Promotions>(`/technicians/me/promotions?currency=${currency}`);
  const [amount, setAmount] = useState('');
  const [speed, setSpeed] = useState<'standard' | 'instant'>('standard');
  const [quote, setQuote] = useState<{ feeMinor: number; netMinor: number; scheduledFor: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <Screen><ErrorText error={error} /></Screen>;
  const p = data.performance;
  const balance = data.wallet.find((w) => w.currency === currency)?.balance_minor ?? 0;

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      await Promise.all([reload(), promos.reload()]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const minor = toMinor(Number(amount) || 0, currency);
  const previewPayout = async (s: 'standard' | 'instant') => {
    setSpeed(s);
    if (minor > 0) setQuote(await api(`/technicians/me/payouts/quote?amountMinor=${minor}&currency=${currency}&speed=${s}`));
  };

  return (
    <Screen>
      {/* Section 7a: performance multiplier = labor rate adjustment from the rolling rating */}
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.label}>Performance multiplier (labor only)</Text>
          <Badge label={p.current.tierStars ? `${p.current.tierStars}★ tier` : 'Not rated yet'} tone={(p.current.tierStars ?? 3) >= 4 ? 'good' : (p.current.tierStars ?? 3) <= 2 ? 'bad' : 'neutral'} />
        </View>
        <Text style={{ fontSize: 34, fontWeight: '800', color: colors.primary }}>
          {p.current.multiplier.toFixed(2)}× <Text style={{ fontSize: 16, color: colors.muted }}>({signed(p.current.adjustmentBps)} on labor)</Text>
        </Text>
        {p.current.reasons.map((r) => (
          <Muted key={r}>• {r}</Muted>
        ))}
        <Muted>
          Rolling rating {p.rollingRating != null ? `${p.rollingRating.toFixed(2)}★ from ${p.ratingCount} review(s)` : '—'} (recent reviews count more). Recalculated every {p.cycleDays} days
          {p.nextRecalculationAt ? ` — next on ${new Date(p.nextRecalculationAt).toLocaleDateString()}` : ''}. Quotes you've already sent keep their rate.
        </Muted>
        {p.projected.stars !== p.current.tierStars && p.projected.stars !== null && (
          <Muted>
            At the next recalculation your rating would put you in the {p.projected.stars}★ tier ({signed(p.projected.adjustmentBps)}).
          </Muted>
        )}
        {p.heldForReview && <Badge label="A recent change is being reviewed by HANDIWORK" tone="warn" />}
        {p.adminOverride && <Badge label="Rate set by HANDIWORK" tone="neutral" />}
        <View style={[styles.row, { marginTop: 4 }]}>
          {p.tiers.map((t) => (
            <Badge key={t.stars} label={`${t.stars}★ ≥ ${t.minRating.toFixed(1)}: ${signed(t.adjustmentBps)}`} tone={p.current.tierStars === t.stars ? 'good' : 'neutral'} />
          ))}
        </View>
        {p.next ? (
          <Text style={[styles.label, { marginTop: 6 }]}>
            Next tier: {p.next.stars}★ ({signed(p.next.adjustmentBps)}) at a rolling rating of {p.ratingNeeded?.toFixed(1)}★
          </Text>
        ) : (
          <Muted>You're in the top tier. Keep it up!</Muted>
        )}
        <Muted>
          {p.stats.completedJobs} completed · {p.stats.technicianCancellations} cancelled · {p.stats.disputes} disputes
        </Muted>
      </Card>

      {/* Earnings */}
      {data.earnings.map((e) => (
        <Card key={e.currency}>
          <Text style={styles.label}>Earnings ({e.currency})</Text>
          <Text style={{ fontSize: 24, fontWeight: '800', color: colors.ink }}>{formatMoney(e.net_minor, e.currency)}</Text>
          <Muted>
            {e.jobs_paid} paid jobs · {formatMoney(e.net_this_month_minor, e.currency)} this month
          </Muted>
          <Muted>
            Labor {formatMoney(e.labor_minor, e.currency)} · Parts reimbursed {formatMoney(e.parts_reimbursed_minor, e.currency)} · Markup {formatMoney(e.markup_minor, e.currency)}
          </Muted>
          <Muted>Platform commission {formatMoney(e.commission_minor, e.currency)} (on labor and markup only)</Muted>
        </Card>
      ))}
      {data.pending.map((x) => (
        <Muted key={x.currency}>
          In progress: {x.jobs} job(s) worth {formatMoney(x.amount_minor, x.currency)}
        </Muted>
      ))}

      {/* Payouts */}
      <Card>
        <Text style={styles.label}>Wallet {formatMoney(balance, currency)}</Text>
        <Field label={`Withdraw (${currency})`} value={amount} onChangeText={(v) => (setAmount(v), setQuote(null))} keyboardType="decimal-pad" />
        <View style={styles.row}>
          <Chip label="Standard (free, next batch)" selected={speed === 'standard'} onPress={() => previewPayout('standard')} />
          <Chip label="Instant (fee)" selected={speed === 'instant'} onPress={() => previewPayout('instant')} />
        </View>
        {quote && (
          <Muted>
            Fee {formatMoney(quote.feeMinor, currency)} · you receive {formatMoney(quote.netMinor, currency)} · {speed === 'instant' ? 'sent now' : `sent ${new Date(quote.scheduledFor).toLocaleString()}`}
          </Muted>
        )}
        <Button
          title="Request payout"
          loading={busy === 'payout'}
          disabled={!(minor > 0) || minor > balance}
          onPress={() =>
            run('payout', async () => {
              await api('/technicians/me/payouts', { body: { amountMinor: minor, currency, speed } });
              setAmount('');
              setQuote(null);
              return 'Payout requested';
            })
          }
        />
        <Button title="Wallet history" variant="secondary" onPress={() => router.push('/wallet')} />
        {data.payouts.map((po) => (
          <View key={po.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Muted>
              {po.speed} · {new Date(po.scheduled_for).toLocaleDateString()}
              {po.failure_reason ? ` · ${po.failure_reason}` : ''}
            </Muted>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Text>{formatMoney(po.net_minor, po.currency)}</Text>
              <Badge label={po.status} tone={po.status === 'sent' ? 'good' : po.status === 'failed' ? 'bad' : 'neutral'} />
            </View>
          </View>
        ))}
      </Card>

      {/* Promotions */}
      <Card>
        <Text style={styles.label}>Get more jobs</Text>
        {data.promotions.boosts.map((b) => (
          <Muted key={b.id}>
            Boost active{b.category_name ? ` (${b.category_name})` : ''} until {new Date(b.ends_at).toLocaleDateString()}
          </Muted>
        ))}
        {data.promotions.alerts.map((a) => (
          <Muted key={a.id}>
            Priority alerts ({a.radius_factor}× reach) until {new Date(a.ends_at).toLocaleDateString()}
          </Muted>
        ))}
        {promos.data && !promos.data.eligibility.eligible && promos.data.eligibility.reasons.map((r) => <Muted key={r}>⚠ {r}</Muted>)}
        {promos.data?.products.map((prod) => (
          <Button
            key={prod.key}
            title={`${prod.label} — ${formatMoney(prod.priceMinor, currency)}`}
            variant="secondary"
            disabled={!promos.data?.eligibility.eligible || balance < prod.priceMinor}
            loading={busy === prod.key}
            onPress={() => run(prod.key, async () => void (await api('/technicians/me/promotions', { body: { product: prod.key, currency } })))}
          />
        ))}
        <Muted>Paid from your wallet balance.</Muted>
      </Card>
      {msg ? <Muted>{msg}</Muted> : null}
      <ErrorText error={err} />
    </Screen>
  );
}
