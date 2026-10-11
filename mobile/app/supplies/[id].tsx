import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView } from 'react-native';
import { api } from '../../src/api/client';
import { Stars } from '../../src/components/StarInput';
import { Button, Card, Loading, Row, Screen, T, Tag } from '../../src/components/ui';
import { cartStore } from '../../src/lib/cart';
import { formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

export default function Product() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: p } = useQuery({ queryKey: ['supply-product', id], queryFn: () => api(`/supplies/products/${id}`) });
  const [qty, setQty] = useState(1);
  if (!p) return <Loading />;

  const tiers: any[] = [...(p.bulk_tiers ?? [])].sort((a, b) => a.minQty - b.minQty);
  const applicable = tiers.filter((x) => qty >= x.minQty).reduce((a: any, b: any) => (!a || b.unitPriceMinor < a.unitPriceMinor ? b : a), null);
  const unit = applicable && applicable.unitPriceMinor < p.price_minor ? applicable.unitPriceMinor : p.price_minor;
  const next = tiers.find((x) => x.minQty > qty && x.unitPriceMinor < unit);
  const maxQty = p.stock_qty ?? 100_000;

  const add = (replace = false) => {
    const ok = cartStore.add(
      { id: p.seller_id, name: p.seller_name },
      { productId: p.id, name: p.name, unit: p.unit, priceMinor: p.price_minor, quantity: qty, imageUrl: p.image_urls?.[0] },
      replace,
    );
    if (!ok) {
      Alert.alert('Start a new cart?', 'Your cart has items from another seller. Each order comes from one seller.', [
        { text: 'Keep current cart', style: 'cancel' },
        { text: 'Start new cart', style: 'destructive', onPress: () => add(true) },
      ]);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert('Added to cart', `${qty} × ${p.name}`, [
      { text: 'Keep shopping', style: 'cancel', onPress: () => router.back() },
      { text: 'View cart', onPress: () => router.push('/supplies/cart') },
    ]);
  };

  return (
    <Screen>
      {p.image_urls?.length ? (
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}>
          {p.image_urls.map((u: string) => <Image key={u} source={{ uri: u }} style={{ width: 340, height: 240, borderRadius: t.radius.md, marginRight: 8 }} contentFit="cover" />)}
        </ScrollView>
      ) : null}
      <T v="title">{p.name}</T>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="heading" style={t.font.money}>{formatMoney(p.price_minor)} <T muted>/ {p.unit}</T></T>
        {p.stock_qty !== null ? <Tag label={p.stock_qty > 0 ? `${p.stock_qty} in stock` : 'Out of stock'} tone={p.stock_qty > 0 ? 'neutral' : 'danger'} /> : null}
      </Row>
      {p.description ? <T>{p.description}</T> : null}

      {tiers.length ? (
        <Card>
          <T v="heading">Bulk prices</T>
          {tiers.map((x) => (
            <Row key={`${x.minQty}-${x.audience}`} style={{ justifyContent: 'space-between' }}>
              <T muted>{x.minQty}+ {p.unit}{x.audience === 'technician' ? ' · technicians' : ''}</T>
              <T style={t.font.money}>{formatMoney(x.unitPriceMinor)} each</T>
            </Row>
          ))}
        </Card>
      ) : null}

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T>Quantity</T>
          <Row gap={3}>
            <Pressable hitSlop={10} onPress={() => setQty(Math.max(1, qty - 1))}><T v="title">−</T></Pressable>
            <T v="heading" style={{ minWidth: 40, textAlign: 'center' }}>{qty}</T>
            <Pressable hitSlop={10} onPress={() => setQty(Math.min(maxQty, qty + 1))}><T v="title">+</T></Pressable>
          </Row>
        </Row>
        <Row style={{ justifyContent: 'space-between' }}>
          <T muted>{formatMoney(unit)} each</T>
          <T v="heading" style={t.font.money}>{formatMoney(unit * qty)}</T>
        </Row>
        {next ? (
          <Pressable onPress={() => setQty(next.minQty)}>
            <T v="small" style={{ color: t.color.link }}>Buy {next.minQty - qty} more to pay {formatMoney(next.unitPriceMinor)} each</T>
          </Pressable>
        ) : null}
        <Button title="Add to cart" disabled={p.stock_qty === 0} onPress={() => add()} />
      </Card>

      <Card>
        <T v="heading">{p.seller_name}</T>
        {p.seller_rating ? <Stars value={Number(p.seller_rating)} count={p.seller_rating_count} /> : <T v="small" muted>New seller</T>}
        <T v="small" muted>{p.offers_delivery ? `Delivery ${formatMoney(p.delivery_fee_minor)} or pickup` : 'Pickup only'}{p.pickup_address ? ` · ${p.pickup_address}` : ''}</T>
        {(p.sellerReviews ?? []).slice(0, 3).map((r: any, i: number) => (
          <T key={i} v="small">“{r.review_text ?? '★'.repeat(r.rating)}” — {r.buyer}</T>
        ))}
      </Card>
    </Screen>
  );
}
