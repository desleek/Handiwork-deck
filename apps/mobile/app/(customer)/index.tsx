import Ionicons from '@expo/vector-icons/Ionicons';
import { SERVICE_SEGMENTS } from '@handiwork/shared';
import { router } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdSlot } from '@/components/AdSlot';
import { colors, ErrorText, Loading, Muted, Screen, Title } from '@/components/ui';
import { type Category, SEGMENT_LABEL } from '@/lib/categories';
import { useApi } from '@/lib/useApi';

export default function CustomerHome() {
  const { data, error, loading } = useApi<{ categories: Category[] }>('/categories');
  if (loading && !data) return <Loading />;

  return (
    <Screen>
      <Title>What do you need done?</Title>
      <ErrorText error={error} />
      {SERVICE_SEGMENTS.map((segment) => (
        <View key={segment} style={{ gap: 8 }}>
          <Muted>{SEGMENT_LABEL[segment]}</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {data?.categories
              .filter((c) => c.segment === segment)
              .map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => router.push({ pathname: '/post-job', params: { categoryId: String(c.id), name: c.name } })}
                  style={({ pressed }) => ({
                    width: '31%',
                    aspectRatio: 1,
                    backgroundColor: '#fff',
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: colors.line,
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 8,
                    gap: 6,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <Ionicons name={(c.icon ?? 'construct') as ComponentProps<typeof Ionicons>['name']} size={26} color={colors.primary} />
                  <Text style={{ textAlign: 'center', fontSize: 12, fontWeight: '500' }}>{c.name}</Text>
                </Pressable>
              ))}
          </View>
        </View>
      ))}
      <AdSlot />
    </Screen>
  );
}
