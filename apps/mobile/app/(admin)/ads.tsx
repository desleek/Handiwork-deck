import { toMinor } from '@handiwork/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Badge, Button, Card, Chip, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { PLACEMENT_LABEL, PRICING_LABEL } from '@/lib/marketplace';
import { useApi } from '@/lib/useApi';

type Placement = keyof typeof PLACEMENT_LABEL;
interface Campaign {
  id: string;
  title: string;
  body: string | null;
  click_url: string | null;
  placement: Placement;
  status: string;
  pricing_model: keyof typeof PRICING_LABEL;
  rate_minor: number;
  currency: string;
  impressions: number;
  clicks: number;
  spent_minor: number;
  budget_minor: number;
  advertiser_name: string | null;
  seller_name: string | null;
  managed_by_admin: boolean;
}
interface Analytics {
  byPlacement: { currency: string; placement: Placement; impressions: number; clicks: number; revenue_minor: number }[];
  top: { id: string; title: string; currency: string; revenue_minor: number }[];
}
interface Owners {
  advertisers: { id: string; full_name: string; company_name: string | null }[];
  sellers: { id: string; name: string; city: string | null }[];
}

const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { active: 'good', pending_review: 'warn', rejected: 'bad' };

/** Section 12 admin: review submissions, upload/manage campaigns, and see ad revenue. */
export default function AdsAdmin() {
  const list = useApi<{ campaigns: Campaign[]; enabled: boolean; selfServe: boolean }>('/admin/ads/campaigns');
  const stats = useApi<Analytics>('/admin/ads/analytics?days=30');
  const owners = useApi<Owners>('/admin/ads/owners');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [form, setForm] = useState({ placement: 'featured_seller' as Placement, ownerId: '', title: '', body: '', clickUrl: '', keywords: '', budget: '' });
  const [busy, setBusy] = useState(false);

  if (list.loading && !list.data) return <Loading />;
  const reload = () => Promise.all([list.reload(), stats.reload()]);
  const run = (p: Promise<unknown>) => p.then(reload).catch(setErr);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const isSeller = !!owners.data?.sellers.some((s) => s.id === form.ownerId);
      await api('/admin/ads/campaigns', {
        body: {
          placement: form.placement,
          ...(isSeller ? { sellerId: form.ownerId } : { advertiserId: form.ownerId }),
          title: form.title.trim(),
          body: form.body.trim() || undefined,
          clickUrl: form.clickUrl.trim() || undefined,
          searchKeywords: form.keywords.split(',').map((k) => k.trim()).filter((k) => k.length >= 2),
          budgetMinor: form.budget ? toMinor(Number(form.budget), 'NGN') : 0,
          currency: 'NGN',
        },
      });
      setForm({ ...form, title: '', body: '', clickUrl: '', keywords: '', budget: '' });
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const pending = list.data?.campaigns.filter((c) => c.status === 'pending_review') ?? [];
  const others = list.data?.campaigns.filter((c) => c.status !== 'pending_review') ?? [];
  const ownerChoices =
    form.placement === 'featured_seller'
      ? (owners.data?.sellers ?? []).map((s) => ({ id: s.id, label: s.name }))
      : [
          ...(owners.data?.advertisers ?? []).map((a) => ({ id: a.id, label: a.company_name ?? a.full_name })),
          ...(owners.data?.sellers ?? []).map((s) => ({ id: s.id, label: `${s.name} (seller)` })),
        ];

  return (
    <Screen>
      <ErrorText error={list.error ?? err} />
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={styles.label}>Marketplace module</Text>
          <Badge label={list.data?.enabled ? 'On' : 'Off'} tone={list.data?.enabled ? 'good' : 'bad'} />
        </View>
        <Muted>Self-serve advertisers: {list.data?.selfServe ? 'on' : 'off (admin-managed)'}. Slot pricing, the sponsored cap and the on/off switch live in platform settings.</Muted>
        <Button title="Advertising settings" variant="secondary" onPress={() => router.push('/admin-settings')} />
      </Card>

      <Text style={styles.label}>Revenue (30 days)</Text>
      {stats.data?.byPlacement.length === 0 && <Muted>No ad activity yet.</Muted>}
      {stats.data?.byPlacement.map((p) => (
        <Muted key={`${p.currency}-${p.placement}`}>
          {PLACEMENT_LABEL[p.placement]}: {formatMoney(p.revenue_minor, p.currency)} · {p.impressions} views · {p.clicks} clicks
        </Muted>
      ))}
      {stats.data?.top.slice(0, 3).map((t) => (
        <Muted key={t.id}>
          Top: {t.title} — {formatMoney(t.revenue_minor, t.currency)}
        </Muted>
      ))}

      <Text style={styles.label}>Awaiting review</Text>
      {pending.length === 0 && <Muted>No submissions awaiting review.</Muted>}
      {pending.map((c) => (
        <Card key={c.id}>
          <Text style={{ fontWeight: '600' }}>{c.title}</Text>
          <Muted>
            {PLACEMENT_LABEL[c.placement]} · {c.advertiser_name ?? c.seller_name}
          </Muted>
          {c.body ? <Text>{c.body}</Text> : null}
          {c.click_url ? <Muted>{c.click_url}</Muted> : null}
          <Field label="Note to advertiser" value={notes[c.id] ?? ''} onChangeText={(v) => setNotes({ ...notes, [c.id]: v })} />
          <View style={styles.row}>
            <Button title="Approve" onPress={() => run(api(`/admin/ads/campaigns/${c.id}/review`, { body: { decision: 'approve', note: notes[c.id] || undefined } }))} />
            <Button title="Reject" variant="secondary" onPress={() => run(api(`/admin/ads/campaigns/${c.id}/review`, { body: { decision: 'reject', note: notes[c.id] || undefined } }))} />
          </View>
        </Card>
      ))}

      <Text style={styles.label}>New campaign (manual upload)</Text>
      <Card>
        <View style={styles.row}>
          {(Object.keys(PLACEMENT_LABEL) as Placement[]).map((p) => (
            <Chip key={p} label={PLACEMENT_LABEL[p]} selected={form.placement === p} onPress={() => setForm({ ...form, placement: p, ownerId: '' })} />
          ))}
        </View>
        <Muted>{form.placement === 'featured_seller' ? 'Verified registry seller' : 'Advertiser or seller'}</Muted>
        <View style={styles.row}>
          {ownerChoices.slice(0, 20).map((o) => (
            <Chip key={o.id} label={o.label} selected={form.ownerId === o.id} onPress={() => setForm({ ...form, ownerId: o.id })} />
          ))}
        </View>
        <Field label="Headline" value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} maxLength={80} />
        <Field label="Body" value={form.body} onChangeText={(v) => setForm({ ...form, body: v })} maxLength={280} multiline />
        <Field label="Link" value={form.clickUrl} onChangeText={(v) => setForm({ ...form, clickUrl: v })} autoCapitalize="none" />
        {form.placement === 'sponsored_search' && (
          <Field label="Search keywords (comma separated)" value={form.keywords} onChangeText={(v) => setForm({ ...form, keywords: v })} autoCapitalize="none" />
        )}
        <Field label="Budget (NGN, optional)" value={form.budget} onChangeText={(v) => setForm({ ...form, budget: v })} keyboardType="decimal-pad" />
        <Button title="Create & activate" loading={busy} disabled={!form.ownerId || form.title.trim().length < 3} onPress={create} />
      </Card>

      <Text style={styles.label}>Campaigns</Text>
      {others.map((c) => (
        <Card key={c.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '600', flex: 1 }}>{c.title}</Text>
            <Badge label={c.status.replace('_', ' ')} tone={TONE[c.status] ?? 'neutral'} />
          </View>
          <Muted>
            {PLACEMENT_LABEL[c.placement]} · {c.advertiser_name ?? c.seller_name} · {formatMoney(c.rate_minor, c.currency)} {PRICING_LABEL[c.pricing_model]}
          </Muted>
          <Muted>
            {c.impressions} views · {c.clicks} clicks · earned {formatMoney(c.spent_minor, c.currency)}
          </Muted>
          <View style={styles.row}>
            {c.status === 'active' && <Button title="Pause" variant="secondary" onPress={() => run(api(`/admin/ads/campaigns/${c.id}/status`, { body: { status: 'paused' } }))} />}
            {(c.status === 'paused' || c.status === 'draft') && (
              <Button title="Activate" variant="secondary" onPress={() => run(api(`/admin/ads/campaigns/${c.id}/status`, { body: { status: 'active' } }))} />
            )}
            {c.status !== 'ended' && c.status !== 'rejected' && (
              <Button title="End" variant="secondary" onPress={() => run(api(`/admin/ads/campaigns/${c.id}/status`, { body: { status: 'ended' } }))} />
            )}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
