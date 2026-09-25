import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';
import { colors } from './ui';

export const STAR = '#F5A524';

export function RatingLine({ avg, count }: { avg: number; count: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <Ionicons name="star" size={13} color={STAR} />
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.ink }}>{count ? Number(avg).toFixed(1) : 'New'}</Text>
      {count ? <Text style={{ fontSize: 12, color: colors.muted }}>({count})</Text> : null}
    </View>
  );
}

/** 1–5 star picker used by the mandatory review form. */
export function StarPicker({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: colors.ink, flex: 1 }}>{label}</Text>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => onChange(n)} hitSlop={6} accessibilityLabel={`${label}: ${n} stars`}>
            <Ionicons name={n <= value ? 'star' : 'star-outline'} size={24} color={STAR} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Horizontal bar for per-category average scores on a profile. */
export function ScoreBar({ label, value }: { label: string; value: number | null }) {
  const pct = value ? (value / 5) * 100 : 0;
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 13, color: colors.ink }}>{label}</Text>
        <Text style={{ fontSize: 13, color: colors.muted }}>{value ? value.toFixed(1) : '—'}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.line }}>
        <View style={{ height: 6, borderRadius: 3, width: `${pct}%`, backgroundColor: STAR }} />
      </View>
    </View>
  );
}
