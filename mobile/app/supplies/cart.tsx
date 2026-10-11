import { useMutation, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { Banner, Button, Card, Divider, Empty, Row, Screen, T, useChoiceSheet } from '../../src/components/ui';
import { cartStore, useCart } from '../../src/lib/cart';
import { chooseChannel, completeCheckout } from '../../src/lib/checkout';
import { formatMoney } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

/** Checkout: prices come from the server (bulk & technician tiers, stock, delivery fee). Paid into escrow. */
export default function Cart() {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const cart = useCart();
  const [fulfilment, setFulfilment] = useState<'pickup' | 'delivery'>('pickup');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');

  const body = { sellerId: cart.sellerId, items: cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), fulfilment, deliveryAddress: fulfilment === 'delivery' ? address : undefined, note: note || undefined };
  const quote = useQuery({
    queryKey: ['cart-quote', JSON.stringify(body)],
    queryFn: () => api('/supplies/orders/quote', { body }),
    enabled: !!cart.sellerId && cart.items.length > 0,
  });

  const place = useMutation({
    mutationFn: async () => {
      const order = await api('/supplies/orders', { body });
      const channel = await chooseChannel(sheet.open, `Pay ${formatMoney(order.total_minor)} with`);
      if (channel) await completeCheckout(await api(`/supplies/orders/${order.id}/pay`, { body: { channel } }));
      return order;
    },
    onSuccess: () => {
      cartStore.clear();
      queryClient.invalidateQueries({ queryKey: ['supply-orders'] });
      router.replace('/supplies/orders');
    },
    onError: (e: ApiError) => Alert.alert('Order not placed', e.message),
  });

  if (!cart.items.length) return <Screen><Empty title="Your cart is empty" body="Add parts and materials from verified sellers." /></Screen>;
  const q = quote.data;
  const issues: any[] = q?.issues ?? [];
  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  return (
    <Screen>
      {sheet.element}
      <T v="heading">{cart.sellerName}</T>
      <Card>
        {cart.items.map((i) => {
          const line = q?.lines?.find((l: any) => l.productId === i.productId);
          return (
            <View key={i.productId} style={{ gap: 4 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T style={{ flex: 1 }}>{i.name}</T>
                <T style={t.font.money}>{formatMoney(line?.lineTotalMinor ?? i.priceMinor * i.quantity)}</T>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={3}>
                  <Pressable hitSlop={10} onPress={() => cartStore.setQty(i.productId, i.quantity - 1)}><T v="heading">−</T></Pressable>
                  <T>{i.quantity} {i.unit}</T>
                  <Pressable hitSlop={10} onPress={() => cartStore.setQty(i.productId, i.quantity + 1)}><T v="heading">+</T></Pressable>
                </Row>
                {line && line.unitPriceMinor < line.listPriceMinor ? <T v="small" style={{ color: t.color.primary }}>{formatMoney(line.unitPriceMinor)} each (bulk)</T> : null}
              </Row>
              {line?.nextTier ? (
                <Pressable onPress={() => cartStore.setQty(i.productId, line.nextTier.minQty)}>
                  <T v="tiny" style={{ color: t.color.link }}>Add {line.nextTier.minQty - i.quantity} more for {formatMoney(line.nextTier.unitPriceMinor)} each</T>
                </Pressable>
              ) : null}
              <Divider />
            </View>
          );
        })}
      </Card>

      <Card>
        <Row>
          {(['pickup', 'delivery'] as const).map((f) => (
            <Pressable key={f} onPress={() => setFulfilment(f)} style={{ flex: 1, padding: t.space(3), borderRadius: t.radius.sm, alignItems: 'center', backgroundColor: fulfilment === f ? t.color.primary : t.color.surfaceAlt }}>
              <T style={{ color: fulfilment === f ? t.color.primaryText : t.color.text }}>{f === 'pickup' ? 'Pickup' : 'Delivery'}</T>
            </Pressable>
          ))}
        </Row>
        {fulfilment === 'delivery' ? <TextInput value={address} onChangeText={setAddress} placeholder="Delivery address" placeholderTextColor={t.color.textMuted} style={input} /> : null}
        <TextInput value={note} onChangeText={setNote} placeholder="Note for the seller (optional)" placeholderTextColor={t.color.textMuted} style={input} />
      </Card>

      {issues.length ? <Banner tone="danger" text={issues.map((x) => x.message).join('\n')} /> : null}
      {q ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}><T muted>Items</T><T style={t.font.money}>{formatMoney(q.subtotalMinor)}</T></Row>
          {q.discountMinor ? <Row style={{ justifyContent: 'space-between' }}><T muted>Bulk discount</T><T style={[t.font.money, { color: t.color.primary }]}>−{formatMoney(q.discountMinor)}</T></Row> : null}
          {q.deliveryFeeMinor ? <Row style={{ justifyContent: 'space-between' }}><T muted>Delivery</T><T style={t.font.money}>{formatMoney(q.deliveryFeeMinor)}</T></Row> : null}
          <Row style={{ justifyContent: 'space-between' }}><T v="heading">Total</T><T v="heading" style={t.font.money}>{formatMoney(q.totalMinor)}</T></Row>
          <T v="tiny" muted>Held securely and paid to the seller when you confirm you've received your order.</T>
        </Card>
      ) : null}
      <Button title="Place order & pay" loading={place.isPending} disabled={!q || issues.length > 0 || (fulfilment === 'delivery' && address.trim().length < 5)} onPress={() => place.mutate()} />
      <Button title="Empty cart" kind="ghost" onPress={() => cartStore.clear()} />
    </Screen>
  );
}
