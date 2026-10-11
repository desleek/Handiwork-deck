import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { api } from '../../src/api/client';
import { Stars } from '../../src/components/StarInput';
import { Empty, Loading, PlatformIcon, Row, T, Tag } from '../../src/components/ui';
import { useMe } from '../../src/lib/auth';
import { useCart } from '../../src/lib/cart';
import { formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

/** Supplies marketplace (Section 13): parts, tools and materials from verified sellers. */
export default function SuppliesHome() {
  const t = useTheme();
  const me = useMe();
  const cart = useCart();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const products = useQuery({
    queryKey: ['supplies', debounced],
    queryFn: () => api<any[]>('/supplies/products', { query: { search: debounced } }),
  });
  const count = cart.items.reduce((a, i) => a + i.quantity, 0);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg }}>
      <Stack.Screen
        options={{
          title: 'Supplies',
          headerRight: () => (
            <Row gap={4}>
              <Pressable hitSlop={8} onPress={() => router.push('/supplies/orders')}>
                <T v="small" style={{ color: t.color.primary }}>Orders</T>
              </Pressable>
              <Pressable hitSlop={8} onPress={() => router.push('/supplies/cart')} accessibilityLabel={`Cart, ${count} items`}>
                <Row gap={1}>
                  <PlatformIcon name="cart-outline" color={t.color.primary} size={20} />
                  {count ? <T v="small" style={{ color: t.color.primary }}>{count}</T> : null}
                </Row>
              </Pressable>
            </Row>
          ),
        }}
      />
      <FlatList
        contentContainerStyle={{ padding: t.space(4), gap: t.space(3) }}
        data={products.data ?? []}
        numColumns={2}
        columnWrapperStyle={{ gap: t.space(3) }}
        keyExtractor={(p) => p.id}
        ListHeaderComponent={
          <View style={{ gap: t.space(2), marginBottom: t.space(1) }}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={() => setDebounced(search.trim())}
              returnKeyType="search"
              placeholder="Search cement, pipes, cables, inverter batteries…"
              placeholderTextColor={t.color.textMuted}
              style={{ backgroundColor: t.color.surface, borderRadius: t.radius.md, padding: t.space(3), color: t.color.text, fontSize: 16 }}
            />
            {me.role === 'technician' ? <T v="small" style={{ color: t.color.primary }}>Technician bulk prices apply automatically at checkout.</T> : null}
          </View>
        }
        ListEmptyComponent={products.isLoading ? <Loading /> : <Empty title="Nothing found" body="Try another search." />}
        renderItem={({ item: p }) => {
          const bestTier = (p.bulk_tiers ?? []).reduce((a: any, b: any) => (!a || b.unitPriceMinor < a.unitPriceMinor ? b : a), null);
          return (
            <Pressable onPress={() => router.push(`/supplies/${p.id}`)} style={[{ flex: 1, backgroundColor: t.color.surface, borderRadius: t.radius.md, overflow: 'hidden' }, t.shadow]}>
              <View style={{ aspectRatio: 1, backgroundColor: t.color.surfaceAlt }}>
                {p.image_urls?.[0] ? <Image source={{ uri: p.image_urls[0] }} style={{ flex: 1 }} contentFit="cover" /> : null}
              </View>
              <View style={{ padding: t.space(3), gap: 3 }}>
                <T v="heading" numberOfLines={2}>{p.name}</T>
                <T style={t.font.money}>{formatMoney(p.price_minor)} <T v="tiny" muted>/ {p.unit}</T></T>
                {bestTier ? <Tag label={`${formatMoney(bestTier.unitPriceMinor)} from ${bestTier.minQty}${bestTier.audience === 'technician' ? ' (pro)' : ''}`} tone="success" /> : null}
                <T v="tiny" muted numberOfLines={1}>{p.seller_name}</T>
                {p.seller_rating ? <Stars value={Number(p.seller_rating)} count={p.seller_rating_count} /> : null}
                {!p.in_stock ? <Tag label="Out of stock" tone="danger" /> : null}
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
