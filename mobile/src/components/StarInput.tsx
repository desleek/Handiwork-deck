import * as Haptics from 'expo-haptics';
import { Pressable } from 'react-native';
import { useTheme } from '../theme';
import { PlatformIcon, Row, T } from './ui';

export function StarInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: t.space(1.5) }}>
      <T style={{ flex: 1 }}>{label}</T>
      <Row gap={1}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable
            key={n}
            hitSlop={6}
            accessibilityLabel={`${label}: ${n} star${n > 1 ? 's' : ''}`}
            onPress={() => {
              Haptics.selectionAsync();
              onChange(n);
            }}
          >
            <PlatformIcon name={n <= value ? 'star' : 'star-outline'} size={28} color={n <= value ? t.color.star : t.color.textMuted} />
          </Pressable>
        ))}
      </Row>
    </Row>
  );
}

export function Stars({ value, count }: { value: number | null; count?: number }) {
  const t = useTheme();
  return (
    <Row gap={1} style={{ gap: 3 }}>
      <PlatformIcon name="star" size={14} color={t.color.star} />
      <T v="smallStrong">{value ? value.toFixed(1) : 'New'}</T>
      {count !== undefined && count > 0 ? <T v="small" muted>({count})</T> : null}
    </Row>
  );
}
