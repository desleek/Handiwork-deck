import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable } from 'react-native';
import { api } from '../api/client';
import type { JobSummary } from '../api/types';
import { formatMoney } from '../lib/money';
import { useTheme } from '../theme';
import { Card, Empty, Loading, Row, T, Tag } from './ui';

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
      contentContainerStyle={{ padding: t.space(4), gap: t.space(3) }}
      data={data ?? []}
      keyExtractor={(j) => j.id}
      refreshing={isRefetching}
      onRefresh={refetch}
      ListHeaderComponent={
        <>
          {header}
          <Row style={{ marginBottom: t.space(1) }}>
            {(['active', 'history'] as const).map((s) => (
              <Pressable key={s} onPress={() => setScope(s)} style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 100, backgroundColor: scope === s ? t.color.primary : t.color.surface }}>
                <T v="small" style={{ color: scope === s ? t.color.primaryText : t.color.text }}>{s === 'active' ? 'Active' : 'History'}</T>
              </Pressable>
            ))}
          </Row>
        </>
      }
      ListEmptyComponent={isLoading ? <Loading /> : <Empty title={scope === 'active' ? 'No active jobs' : 'Nothing here yet'} />}
      renderItem={({ item }) => {
        const myTurn = item.action_required_from === viewer;
        return (
          <Pressable onPress={() => router.push(`/job/${item.id}`)}>
            <Card style={myTurn ? { borderLeftWidth: 4, borderLeftColor: t.color.primary } : undefined}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={2} style={{ flex: 1 }}>
                  <MaterialCommunityIcons name={item.category_icon as any} size={20} color={t.color.primary} />
                  <T v="heading" numberOfLines={1} style={{ flex: 1 }}>{item.category_name}</T>
                </Row>
                {item.is_fast_track ? <Tag label="Fast Track" tone="warning" /> : null}
              </Row>
              <T numberOfLines={2} muted>{item.description}</T>
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="small">{item.counterpart_name} · #{item.short_code}</T>
                {item.quote_total_minor ? <T v="small" style={t.font.money}>{formatMoney(item.quote_total_minor)}</T> : null}
              </Row>
              {myTurn && item.action_required_reason ? <T v="small" style={{ color: t.color.primary }}>Your turn: {item.action_required_reason}</T> : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}
