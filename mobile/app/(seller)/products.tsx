import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';
import { api } from '../../src/api/client';
import { Button, Empty, Loading, Row, T, Tag } from '../../src/components/ui';
import { formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

export default function SellerProducts() {
  const t = useTheme();
  const { data, isLoading, refetch, isRefetching } = useQuery({ queryKey: ['seller-products'], queryFn: () => api<any[]>('/seller/products') });
  return (
    <FlatList
      style={{ backgroundColor: t.color.bg }}
      contentContainerStyle={{ padding: t.space(4), gap: t.space(3) }}
      data={data ?? []}
      keyExtractor={(p) => p.id}
      refreshing={isRefetching}
      onRefresh={refetch}
      ListHeaderComponent={<Button title="Add product" onPress={() => router.push('/seller/product')} />}
      ListEmptyComponent={isLoading ? <Loading /> : <Empty title="No products yet" body="Add what you sell. New listings are checked by Handiwork-Deck before they appear." />}
      renderItem={({ item: p }) => (
        <Pressable onPress={() => router.push({ pathname: '/seller/product', params: { id: p.id } })}>
          <Row style={[{ backgroundColor: t.color.surface, borderRadius: t.radius.md, padding: t.space(3) }, t.shadow]} gap={3}>
            <View style={{ width: 56, height: 56, borderRadius: t.radius.sm, backgroundColor: t.color.surfaceAlt, overflow: 'hidden' }}>
              {p.image_urls?.[0] ? <Image source={{ uri: p.image_urls[0] }} style={{ flex: 1 }} /> : null}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="heading" numberOfLines={1}>{p.name}</T>
              <T v="small" style={t.font.money}>{formatMoney(p.price_minor)} / {p.unit}{p.stock_qty !== null ? ` · ${p.stock_qty} in stock` : ''}</T>
              <Row gap={1}>
                <Tag label={p.moderation_status === 'approved' ? 'Live' : p.moderation_status === 'pending' ? 'In review' : 'Rejected'} tone={p.moderation_status === 'approved' ? 'success' : p.moderation_status === 'pending' ? 'warning' : 'danger'} />
                {!p.is_active ? <Tag label="Hidden" /> : null}
                {(p.bulk_tiers ?? []).length ? <Tag label={`${p.bulk_tiers.length} bulk tier${p.bulk_tiers.length > 1 ? 's' : ''}`} /> : null}
              </Row>
            </View>
          </Row>
        </Pressable>
      )}
    />
  );
}
