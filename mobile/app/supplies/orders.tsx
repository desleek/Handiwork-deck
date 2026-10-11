import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { StarInput } from '../../src/components/StarInput';
import { Button, Card, Divider, Empty, Loading, Row, Screen, T, Tag, useChoiceSheet } from '../../src/components/ui';
import { chooseChannel, completeCheckout } from '../../src/lib/checkout';
import { formatMoney } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warning' },
  paid: { label: 'Paid — waiting for seller', tone: 'neutral' },
  accepted: { label: 'Being prepared', tone: 'neutral' },
  ready_for_pickup: { label: 'Ready for pickup', tone: 'success' },
  dispatched: { label: 'On the way', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  rejected: { label: 'Declined by seller — refunded', tone: 'danger' },
  disputed: { label: 'In dispute', tone: 'danger' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export default function SupplyOrders() {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const { data, isLoading } = useQuery({ queryKey: ['supply-orders'], queryFn: () => api<any[]>('/supplies/orders') });
  const [rating, setRating] = useState<Record<string, number>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const act = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: unknown }) => api(`/supplies/orders/${id}/${path}`, { body: body ?? {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['supply-orders'] }),
    onError: (e: ApiError) => Alert.alert('Not done', e.message),
  });
  const pay = async (o: any) => {
    const channel = await chooseChannel(sheet.open, `Pay ${formatMoney(o.total_minor)} with`);
    if (!channel) return;
    try {
      await completeCheckout(await api(`/supplies/orders/${o.id}/pay`, { body: { channel } }));
    } catch (e: any) {
      Alert.alert('Payment not started', e.message);
    }
    queryClient.invalidateQueries({ queryKey: ['supply-orders'] });
  };

  if (isLoading) return <Loading />;
  if (!data?.length) return <Screen><Empty title="No orders yet" /></Screen>;
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  return (
    <Screen>
      {sheet.element}
      {data.map((o) => {
        const s = STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
        return (
          <Card key={o.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="heading">{o.seller_name}</T>
              <Tag label={s.label} tone={s.tone} />
            </Row>
            <T v="tiny" muted>#{o.short_code} · {new Date(o.created_at).toLocaleDateString()} · {o.fulfilment === 'pickup' ? 'Pickup' : 'Delivery'}</T>
            {(o.items ?? []).map((i: any) => (
              <Row key={i.id} style={{ justifyContent: 'space-between' }}>
                <T v="small" style={{ flex: 1 }}>{i.quantity} × {i.name}</T>
                <T v="small" style={t.font.money}>{formatMoney(i.line_total_minor)}</T>
              </Row>
            ))}
            <Divider />
            <Row style={{ justifyContent: 'space-between' }}><T>Total</T><T style={t.font.money}>{formatMoney(o.total_minor)}</T></Row>

            {o.status === 'pending_payment' ? <Button title="Pay now" onPress={() => pay(o)} /> : null}
            {['dispatched', 'ready_for_pickup'].includes(o.status) ? (
              <Button title="I've received it — release payment" onPress={() => act.mutate({ id: o.id, path: 'received' })} />
            ) : null}
            {['pending_payment', 'paid'].includes(o.status) ? (
              <Button title="Cancel order" kind="ghost" onPress={() => act.mutate({ id: o.id, path: 'cancel', body: { reason: 'Cancelled by buyer' } })} />
            ) : null}
            {['paid', 'accepted', 'dispatched', 'ready_for_pickup'].includes(o.status) ? (
              <View style={{ gap: t.space(2) }}>
                <TextInput value={text[o.id] ?? ''} onChangeText={(v) => setText((x) => ({ ...x, [o.id]: v }))} placeholder="Problem with this order? Describe it" placeholderTextColor={t.color.textMuted} style={input} />
                <Button title="Open dispute" kind="ghost" disabled={(text[o.id] ?? '').trim().length < 10} onPress={() => act.mutate({ id: o.id, path: 'dispute', body: { reason: text[o.id] } })} />
              </View>
            ) : null}
            {o.status === 'completed' && !o.reviewed ? (
              <View style={{ gap: t.space(1) }}>
                <StarInput label="Rate the seller" value={rating[o.id] ?? 0} onChange={(v) => setRating((r) => ({ ...r, [o.id]: v }))} />
                <TextInput value={text[o.id] ?? ''} onChangeText={(v) => setText((x) => ({ ...x, [o.id]: v }))} placeholder="Review (optional)" placeholderTextColor={t.color.textMuted} style={input} />
                <Button title="Submit review" kind="secondary" disabled={!rating[o.id]} onPress={() => act.mutate({ id: o.id, path: 'review', body: { rating: rating[o.id], review: text[o.id] || undefined } })} />
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
