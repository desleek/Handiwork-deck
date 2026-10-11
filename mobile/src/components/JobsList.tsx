import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { api } from '../api/client';
import type { JobSummary } from '../api/types';
import { formatMoney } from '../lib/money';
import { useTheme } from '../theme';
import { Empty, Loading, Row, Segmented, T, Tag } from './ui';

export function JobsList({ viewer, header }: { viewer: 'customer' | 'technician'; header?: React.ReactElement }) {
  const t = useTheme();
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['jobs', scope],
    queryFn: () => api<JobSummary[]>('/jobs', { query: { scope } }),
    refetchInterval: 30_000,
  });

  return (
    <FlatList
      style={{ backgroundColor: t.color.bg }}
      contentContainerStyle={{ padding: t.space(5) }}
      data={data ?? []}
      keyExtractor={(j) => j.id}
      refreshing={isRefetching}
      onRefresh={refetch}
      ItemSeparatorComponent={() => <View style={{ height: t.space(3) }} />}
      ListHeaderComponent={
        <View style={{ gap: t.space(3), marginBottom: t.space(3) }}>
          {header}
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { key: 'active', label: 'Active' },
              { key: 'history', label: 'History' },
            ]}
          />
        </View>
      }
      ListEmptyComponent={isLoading ? <Loading /> : <Empty icon="briefcase-outline" title={scope === 'active' ? 'No active jobs' : 'Nothing here yet'} />}
      renderItem={({ item }) => {
        const myTurn = item.action_required_from === viewer;
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/job/${item.id}`)}
            style={({ pressed }) => ({ backgroundColor: t.color.surface, borderRadius: t.radius.lg, borderWidth: myTurn ? 1.5 : 1, borderColor: myTurn ? t.color.accent : t.color.border, padding: t.space(4), gap: t.space(2), opacity: pressed ? 0.9 : 1 })}
          >
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={1.5} style={{ flex: 1 }}>
                <MaterialCommunityIcons name={item.category_icon as any} size={18} color={t.color.primary} />
                <T v="label" color={t.color.primary} numberOfLines={1} style={{ flex: 1 }}>{item.category_name}</T>
              </Row>
              {item.is_fast_track ? <Tag label="Fast Track" tone="warning" icon="flash" /> : null}
            </Row>
            {myTurn ? <Tag label={`Your turn${item.action_required_reason ? ` · ${item.action_required_reason}` : ''}`} tone="warning" /> : null}
            <T v="bodyStrong" numberOfLines={2}>{item.description}</T>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="small" muted>{item.counterpart_name} · #{item.short_code}</T>
              {item.quote_total_minor ? <T v="smallStrong" style={t.font.money}>{formatMoney(item.quote_total_minor)}</T> : null}
            </Row>
          </Pressable>
        );
      }}
    />
  );
}
