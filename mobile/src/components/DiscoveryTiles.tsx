import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { Pressable, View } from 'react-native';
import type { DiscoveryItem } from '../api/types';
import { formatMoney } from '../lib/money';
import { useTheme } from '../theme';
import { Stars } from './StarInput';
import { Row, T, Tag } from './ui';

type Tech = Extract<DiscoveryItem, { type: 'technician' }>;
type Sponsored = Extract<DiscoveryItem, { type: 'sponsored' }>;

/** The app's primary visual surface (Section 14): photo, category icon, rating, starting price. */
export function TechnicianTile({ item, onPress }: { item: Tech; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.color.border }}
      accessibilityLabel={`${item.name}, ${item.category.name}${item.label ? ', promoted listing' : ''}`}
      style={({ pressed }) => [
        { flex: 1, backgroundColor: t.color.surface, borderRadius: t.radius.md, overflow: 'hidden', opacity: pressed ? 0.85 : 1 },
        t.shadow,
      ]}
    >
      <View style={{ aspectRatio: 1, backgroundColor: t.color.surfaceAlt }}>
        {item.photoUrl || item.avatarUrl ? (
          <Image source={{ uri: (item.photoUrl ?? item.avatarUrl)! }} style={{ flex: 1 }} contentFit="cover" transition={150} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <MaterialCommunityIcons name={item.category.icon as any} size={48} color={t.color.textMuted} />
          </View>
        )}
        <View style={{ position: 'absolute', left: 8, bottom: 8, backgroundColor: t.color.surface, borderRadius: 100, padding: 6 }}>
          <MaterialCommunityIcons name={item.category.icon as any} size={18} color={t.color.primary} />
        </View>
        {item.isOnline ? (
          <View style={{ position: 'absolute', right: 8, top: 8, width: 10, height: 10, borderRadius: 5, backgroundColor: '#22A06B', borderWidth: 2, borderColor: t.color.surface }} />
        ) : null}
      </View>
      <View style={{ padding: t.space(3), gap: 4 }}>
        {item.label ? <Tag label={item.label} tone="promoted" /> : null}
        <T v="heading" numberOfLines={1}>{item.name}</T>
        <T v="small" muted numberOfLines={1}>{item.category.name}</T>
        <Row style={{ justifyContent: 'space-between' }}>
          <Stars value={item.ratingAvg} count={item.ratingCount} />
          {item.distanceKm !== null ? <T v="tiny" muted>{item.distanceKm} km</T> : null}
        </Row>
        <T v="small">From <T v="small" style={[t.font.money, { fontWeight: '600' }]}>{formatMoney(item.startingPriceMinor)}</T></T>
      </View>
    </Pressable>
  );
}

/** Visually distinct from technician tiles so an ad can never be mistaken for a match (Sections 12, 14). */
export function SponsoredTile({ item }: { item: Sponsored }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => item.ad.click_url && WebBrowser.openBrowserAsync(item.ad.click_url)}
      style={{ flex: 1, backgroundColor: t.color.sponsoredBg, borderRadius: t.radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: t.color.border, padding: t.space(3), gap: 6 }}
    >
      <Tag label="Sponsored" tone="neutral" />
      <Image source={{ uri: item.ad.image_url }} style={{ height: 90, borderRadius: t.radius.sm }} contentFit="cover" />
      <T v="heading" numberOfLines={2}>{item.ad.title}</T>
      {item.ad.seller_name ? <T v="small" muted>{item.ad.seller_name}</T> : null}
    </Pressable>
  );
}
