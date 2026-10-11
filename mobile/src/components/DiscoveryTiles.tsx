import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import type { DiscoveryItem } from '../api/types';
import { trackClick, trackImpression } from '../lib/adTracking';
import { formatMoney } from '../lib/money';
import { useTheme } from '../theme';
import { Stars } from './StarInput';
import { Avatar, Row, T, Tag, VerifiedMark } from './ui';

type Tech = Extract<DiscoveryItem, { type: 'technician' }>;
type Sponsored = Extract<DiscoveryItem, { type: 'sponsored' }>;

/**
 * The app's primary visual surface (Section 14): one technician per row so name, trade, rating,
 * distance and labor rate can all be read at a glance on a small phone. Everyone listed is verified.
 */
export function TechnicianTile({ item, onPress, index = 0 }: { item: Tech; onPress: () => void; index?: number }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: t.color.border }}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, verified, ${item.category.name}${item.ratingAvg ? `, rated ${item.ratingAvg.toFixed(1)}` : ''}${item.distanceKm !== null ? `, ${item.distanceKm} kilometres away` : ''}${item.label ? ', promoted listing' : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: t.space(3.5),
        alignItems: 'center',
        backgroundColor: t.color.surface,
        borderRadius: t.radius.lg,
        borderWidth: 1,
        borderColor: item.label ? t.color.promoted : t.color.border,
        padding: t.space(3.5),
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View>
        <Avatar name={item.name} url={item.photoUrl ?? item.avatarUrl} size={56} tone={index % 2 ? 'marigold' : 'green'} />
        {item.isOnline ? (
          <View accessibilityLabel="Online now" style={{ position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, backgroundColor: t.color.online, borderWidth: 2.5, borderColor: t.color.surface }} />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        {item.label ? <Tag label={item.label} tone="promoted" /> : null}
        <Row gap={1.5}>
          <T v="bodyStrong" numberOfLines={1} style={{ fontSize: 16, flexShrink: 1 }}>{item.name}</T>
          <VerifiedMark />
        </Row>
        <T v="small" muted numberOfLines={1}>
          {item.category.name}
          {item.distanceKm !== null ? ` · ${item.distanceKm} km away` : ''}
        </T>
        <Row gap={3}>
          <Stars value={item.ratingAvg} count={item.ratingCount} />
          <T v="smallStrong" color={t.color.primary} style={t.font.money}>Labor {formatMoney(item.startingPriceMinor)}</T>
        </Row>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={t.color.textMuted} />
    </Pressable>
  );
}

/** Visually distinct from technician rows so an ad can never be mistaken for a match (Sections 12, 14). */
export function SponsoredTile({ item }: { item: Sponsored }) {
  const t = useTheme();
  useEffect(() => trackImpression(item.ad.id), [item.ad.id]);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Sponsored: ${item.ad.title}`}
      onPress={() => {
        trackClick(item.ad.id);
        if (item.ad.click_url) WebBrowser.openBrowserAsync(item.ad.click_url);
      }}
      style={{ flexDirection: 'row', gap: t.space(3), backgroundColor: t.color.sponsoredBg, borderRadius: t.radius.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: t.color.borderStrong, padding: t.space(3) }}
    >
      <Image source={{ uri: item.ad.image_url }} style={{ width: 84, height: 84, borderRadius: t.radius.sm }} contentFit="cover" />
      <View style={{ flex: 1, gap: 4 }}>
        <Tag label="Sponsored" tone="neutral" />
        <T v="bodyStrong" numberOfLines={2}>{item.ad.title}</T>
        {item.ad.seller_name ? <T v="small" muted numberOfLines={1}>{item.ad.seller_name}</T> : null}
      </View>
    </Pressable>
  );
}
