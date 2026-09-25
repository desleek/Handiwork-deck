import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Image, Pressable, Text, View } from 'react-native';
import { iconFor } from '@/lib/categories';
import type { TechCardData } from '@/lib/discover';
import { formatMoney } from '@/lib/format';
import { Avatar } from './Avatar';
import { RatingLine } from './Stars';
import { colors } from './ui';

/**
 * The discovery grid tile: photo first, then category icon, rating and starting
 * price. Boosted technicians carry a visible "Promoted" label.
 */
export function TechCard({ tech }: { tech: TechCardData }) {
  return (
    <Pressable
      onPress={() => router.push(`/technician/${tech.id}`)}
      accessibilityLabel={`${tech.fullName}, ${tech.category.name}${tech.boosted ? ', promoted' : ''}`}
      style={({ pressed }) => ({
        width: '48.5%',
        backgroundColor: colors.card,
        borderRadius: 14,
        borderWidth: tech.boosted ? 1.5 : 1,
        borderColor: tech.boosted ? colors.primary : colors.line,
        overflow: 'hidden',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ aspectRatio: 1.25, backgroundColor: '#FDE7DB', alignItems: 'center', justifyContent: 'center' }}>
        {tech.photoUrl ? (
          <Image source={{ uri: tech.photoUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        ) : (
          <Avatar url={null} name={tech.fullName} size={64} />
        )}
      </View>
      <View style={{ position: 'absolute', top: 8, left: 8, flexDirection: 'row', gap: 6 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 999, padding: 6 }}>
          <Ionicons name={iconFor(tech.category.icon)} size={16} color={colors.primary} />
        </View>
        {tech.boosted && (
          <View style={{ backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 8, justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>Promoted</Text>
          </View>
        )}
      </View>
      {tech.livePosition && (
        <View style={{ position: 'absolute', top: 10, right: 10, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, borderWidth: 2, borderColor: '#fff' }} />
      )}
      <View style={{ padding: 10, gap: 3 }}>
        <Text numberOfLines={1} style={{ fontWeight: '700', color: colors.ink }}>
          {tech.fullName}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: colors.muted }}>
          {tech.category.name}
          {tech.distanceKm != null ? ` · ${tech.distanceKm} km` : ''}
        </Text>
        <RatingLine avg={tech.rating.avg} count={tech.rating.count} />
        <Text style={{ fontSize: 13, color: colors.ink }}>
          {tech.startingPrice ? (
            <>
              <Text style={{ color: colors.muted }}>From </Text>
              <Text style={{ fontWeight: '700' }}>{formatMoney(tech.startingPrice.amountMinor, tech.startingPrice.currency)}</Text>
            </>
          ) : (
            <Text style={{ color: colors.muted }}>Quote on request</Text>
          )}
        </Text>
        {tech.instantBook && <Text style={{ fontSize: 11, color: colors.success, fontWeight: '600' }}>⚡ Instant book</Text>}
      </View>
    </Pressable>
  );
}
