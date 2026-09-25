import { Image, Text, View } from 'react-native';
import { colors } from './ui';

export function Avatar({ url, name, size = 56, radius }: { url: string | null; name: string; size?: number; radius?: number }) {
  const r = radius ?? size / 2;
  if (url) return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: r, backgroundColor: colors.line }} />;
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <View style={{ width: size, height: size, borderRadius: r, backgroundColor: '#FDE7DB', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.primaryDark, fontWeight: '700', fontSize: size * 0.34 }}>{initials}</Text>
    </View>
  );
}
