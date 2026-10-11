import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, FlatList, Pressable, TextInput, View } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { Banner, Button, Card, Divider, Empty, Loading, Row, T, Tag } from '../../src/components/ui';
import { formatMoney } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

const FILTERS = [
  { id: 'todo', label: 'To do', statuses: ['paid', 'accepted'] },
  { id: 'out', label: 'Out / ready', statuses: ['dispatched', 'ready_for_pickup'] },
  { id: 'done', label: 'Done', statuses: ['completed', 'rejected', 'cancelled', 'refunded', 'disputed'] },
];

/** Seller order inbox (Section 13): accept → prepare → dispatch / ready for pickup. Paid on buyer confirmation. */
export default function SellerOrders() {
  const t = useTheme();
  const [filter, setFilter] = useState('todo');
  const [reason, setReason] = useState<Record<string, string>>({});
  const store = useQuery({ queryKey: ['storefront'], queryFn: () => api('/seller/storefront'), retry: false });
  const orders = useQuery({ queryKey: ['seller-orders'], queryFn: () => api<any[]>('/seller/orders'), enabled: !!store.data, refetchInterval: 30_000 });
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api(`/seller/orders/${id}/${action}`, { body: body ?? {} }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['seller-orders'] }),
    onError: (e: ApiError) => Alert.alert('Not done', e.message),
  });

  if (store.isLoading) return <Loading />;
  if (store.error) {
    return (
      <View style={{ padding: t.space(4) }}>
        <Banner text="No storefront is linked to this account yet. Handiwork-Deck support links verified sellers to their login." />
      </View>
    );
  }
  const statuses = FILTERS.find((f) => f.id === filter)!.statuses;
  const list = (orders.data ?? []).filter((o) => statuses.includes(o.status));

  return (
    <FlatList
      style={{ backgroundColor: t.color.bg }}
      contentContainerStyle={{ padding: t.space(4), gap: t.space(3) }}
      data={list}
      keyExtractor={(o) => o.id}
      refreshing={orders.isRefetching}
      onRefresh={() => orders.refetch()}
      ListHeaderComponent={
        <View style={{ gap: t.space(3) }}>
          {store.data.storefront_status !== 'live' ? <Banner text={`Storefront status: ${store.data.storefront_status}. Set it up on the Storefront tab.`} /> : null}
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <T muted>Orders to fulfil</T>
              <T v="heading">{store.data.stats?.to_fulfil ?? 0}</T>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <T muted>Earned (30 days)</T>
              <T v="heading" style={t.font.money}>{formatMoney(Number(store.data.stats?.earned_30d_minor ?? 0))}</T>
            </Row>
          </Card>
          <Row>
            {FILTERS.map((f) => (
              <Pressable key={f.id} onPress={() => setFilter(f.id)} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 100, backgroundColor: filter === f.id ? t.color.primary : t.color.surface }}>
                <T v="small" style={{ color: filter === f.id ? t.color.primaryText : t.color.text }}>{f.label}</T>
              </Pressable>
            ))}
          </Row>
        </View>
      }
      ListEmptyComponent={orders.isLoading ? <Loading /> : <Empty title="Nothing here" />}
      renderItem={({ item: o }) => (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="heading">#{o.short_code}</T>
            <Tag label={o.status.replace(/_/g, ' ')} tone={o.status === 'completed' ? 'success' : o.status === 'disputed' ? 'danger' : 'neutral'} />
          </Row>
          <T v="small" muted>
            {o.buyer_name}{o.buyer_role === 'technician' ? ' (technician)' : ''} · {o.fulfilment === 'pickup' ? 'Pickup' : `Deliver to ${o.delivery_address}`}
          </T>
          {(o.items ?? []).map((i: any) => (
            <Row key={i.id} style={{ justifyContent: 'space-between' }}>
              <T v="small" style={{ flex: 1 }}>{i.quantity} {i.unit} × {i.name}</T>
              <T v="small" style={t.font.money}>{formatMoney(i.line_total_minor)}</T>
            </Row>
          ))}
          {o.note ? <T v="small" muted>Note: {o.note}</T> : null}
          <Divider />
          <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Order total</T><T v="small" style={t.font.money}>{formatMoney(o.total_minor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T v="small" muted>Platform fee</T><T v="small" muted>−{formatMoney(o.commission_minor)}</T></Row>
          <Row style={{ justifyContent: 'space-between' }}><T>You receive</T><T style={t.font.money}>{formatMoney(o.seller_net_minor)}</T></Row>

          {o.status === 'paid' ? (
            <View style={{ gap: t.space(2) }}>
              <Button title="Accept order" onPress={() => act.mutate({ id: o.id, action: 'accept' })} />
              <TextInput value={reason[o.id] ?? ''} onChangeText={(v) => setReason((r) => ({ ...r, [o.id]: v }))} placeholder="Reason, if you can't fulfil it" placeholderTextColor={t.color.textMuted} style={{ backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text }} />
              <Button title="Decline & refund buyer" kind="ghost" disabled={!(reason[o.id] ?? '').trim()} onPress={() => act.mutate({ id: o.id, action: 'reject', body: { reason: reason[o.id] } })} />
            </View>
          ) : null}
          {o.status === 'accepted' ? (
            <Button
              title={o.fulfilment === 'pickup' ? 'Mark ready for pickup' : 'Mark dispatched'}
              onPress={() => act.mutate({ id: o.id, action: o.fulfilment === 'pickup' ? 'ready' : 'dispatch' })}
            />
          ) : null}
          {['dispatched', 'ready_for_pickup'].includes(o.status) ? <T v="tiny" muted>Paid out when the buyer confirms receipt, or automatically after a few days.</T> : null}
        </Card>
      )}
    />
  );
}
