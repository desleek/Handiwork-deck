import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Alert, Switch, TextInput, View } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { Stars } from '../../src/components/StarInput';
import { Banner, Button, Card, Divider, Row, Screen, T, Tag, useChoiceSheet } from '../../src/components/ui';
import { chooseChannel, completeCheckout } from '../../src/lib/checkout';
import { formatMoney, toMinor } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

/** Storefront settings (Section 13) and ad campaigns with their stats (Section 12). */
export default function Storefront() {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const store = useQuery({ queryKey: ['storefront'], queryFn: () => api('/seller/storefront'), retry: false });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api<any[]>('/advertiser/campaigns') });
  const [pickup, setPickup] = useState('');
  const [delivers, setDelivers] = useState(false);
  const [fee, setFee] = useState('');

  useEffect(() => {
    if (!store.data) return;
    setPickup(store.data.pickup_address ?? '');
    setDelivers(store.data.offers_delivery);
    setFee(String(store.data.delivery_fee_minor / 100));
  }, [store.data?.id]);

  const save = useMutation({
    mutationFn: (requestLive: boolean) => api('/seller/storefront', { method: 'PUT', body: { pickupAddress: pickup, offersDelivery: delivers, deliveryFeeMinor: toMinor(fee || 0), requestLive } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['storefront'] }),
    onError: (e: ApiError) => Alert.alert('Not saved', e.message),
  });

  const payCampaign = async (c: any) => {
    const channel = await chooseChannel(sheet.open, `Pay ${formatMoney(c.price_minor)} with`);
    if (!channel) return;
    try {
      await completeCheckout(await api(`/advertiser/campaigns/${c.id}/pay`, { body: { channel } }));
    } catch (e: any) {
      Alert.alert('Payment not started', e.message);
    }
    queryClient.invalidateQueries({ queryKey: ['campaigns'] });
  };

  const s = store.data;
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  return (
    <Screen>
      {sheet.element}
      {s ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading">{s.name}</T>
            <Tag label={s.storefront_status} tone={s.storefront_status === 'live' ? 'success' : s.storefront_status === 'suspended' ? 'danger' : 'warning'} />
          </Row>
          {s.rating_avg ? <Stars value={Number(s.rating_avg)} count={s.rating_count} /> : null}
          <T v="small" muted>Pickup address</T>
          <TextInput value={pickup} onChangeText={setPickup} placeholder="Shop address for pickups" placeholderTextColor={t.color.textMuted} style={input} />
          <Row style={{ justifyContent: 'space-between' }}>
            <T>I deliver</T>
            <Switch value={delivers} onValueChange={setDelivers} />
          </Row>
          {delivers ? <TextInput value={fee} onChangeText={setFee} keyboardType="decimal-pad" placeholder="Delivery fee (₦)" placeholderTextColor={t.color.textMuted} style={input} /> : null}
          <Button title="Save" kind="secondary" loading={save.isPending} disabled={pickup.trim().length < 5} onPress={() => save.mutate(false)} />
          {s.storefront_status === 'none' ? <Button title="Request to open storefront" disabled={pickup.trim().length < 5} onPress={() => save.mutate(true)} /> : null}
          {s.storefront_status === 'pending' ? <T v="small" muted>Handiwork-Deck is reviewing your storefront.</T> : null}
        </Card>
      ) : store.error ? (
        <Banner text="No storefront is linked to this account yet." />
      ) : null}

      <T v="heading">Ad campaigns</T>
      {(campaigns.data ?? []).length === 0 ? <T muted>No campaigns yet. Contact Handiwork-Deck to advertise in the Deals tab or sponsored search.</T> : null}
      {(campaigns.data ?? []).map((c) => (
        <Card key={c.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading" style={{ flex: 1 }}>{c.name}</T>
            <Tag label={c.status.replace(/_/g, ' ')} tone={c.status === 'active' ? 'success' : c.status === 'rejected' ? 'danger' : 'neutral'} />
          </Row>
          <T v="small" muted>{c.placement.replace(/_/g, ' ')} · {c.starts_at ? new Date(c.starts_at).toLocaleDateString() : '—'} to {c.ends_at ? new Date(c.ends_at).toLocaleDateString() : '—'}</T>
          {c.rejection_reason ? <Banner tone="danger" text={c.rejection_reason} /> : null}
          <Divider />
          <Row style={{ justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}><T v="heading">{c.impressions}</T><T v="tiny" muted>Views</T></View>
            <View style={{ alignItems: 'center' }}><T v="heading">{c.clicks}</T><T v="tiny" muted>Clicks</T></View>
            <View style={{ alignItems: 'center' }}><T v="heading">{c.ctrPct ?? '—'}{c.ctrPct !== null ? '%' : ''}</T><T v="tiny" muted>CTR</T></View>
          </Row>
          {c.status === 'approved' && c.payment_status === 'unpaid' && c.price_minor ? <Button title={`Pay ${formatMoney(c.price_minor)} to schedule`} onPress={() => payCampaign(c)} /> : null}
        </Card>
      ))}
    </Screen>
  );
}
