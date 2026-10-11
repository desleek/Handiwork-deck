import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { api } from '../../src/api/client';
import type { Category, DiscoveryItem } from '../../src/api/types';
import { SponsoredTile, TechnicianTile } from '../../src/components/DiscoveryTiles';
import { Banner, Empty, Loading, PlatformIcon, Row, T } from '../../src/components/ui';
import { useMe } from '../../src/lib/auth';
import { currentPosition, ensureForegroundLocation } from '../../src/lib/location';
import { formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

/** Icon-first discovery (Section 3): category icons → grid of technicians, or a live map. */
export default function Discover() {
  const t = useTheme();
  const me = useMe();
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [view, setView] = useState<'grid' | 'map'>('grid');
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    ensureForegroundLocation('We use your location to show technicians near you. It is never shared with technicians.').then(async (ok) => {
      if (ok) setLoc(await currentPosition());
    });
  }, []);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ household_office: Category[]; construction: Category[] }>('/categories') });
  const results = useQuery({
    queryKey: ['discover', categoryId, loc?.lat, loc?.lng],
    queryFn: () => api<{ items: DiscoveryItem[] }>('/technicians', { query: { categoryId, lat: loc?.lat, lng: loc?.lng } }),
    refetchInterval: view === 'map' ? 20_000 : false, // live positions on the map
  });

  const all = [...(categories.data?.household_office ?? []), ...(categories.data?.construction ?? [])];
  const items = results.data?.items ?? [];
  // Pad sponsored items to full width rows so they never sit in a technician slot.
  const rows: DiscoveryItem[][] = [];
  let pair: DiscoveryItem[] = [];
  const flush = () => {
    if (pair.length) rows.push(pair);
    pair = [];
  };
  for (const it of items) {
    if (it.type === 'sponsored') {
      flush();
      rows.push([it]);
    } else {
      pair.push(it);
      if (pair.length === 2) flush();
    }
  }
  if (pair.length) rows.push(pair);

  const header = (
    <View style={{ gap: t.space(3), paddingBottom: t.space(3) }}>
      {me.pendingReviewJobIds.length > 0 ? (
        <Pressable onPress={() => router.push(`/job/${me.pendingReviewJobIds[0]}/rate`)}>
          <Banner text="Rate your last job to book again — it takes under a minute." />
        </Pressable>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space(3) }}>
        <CategoryChip label="All" icon="view-grid-outline" active={!categoryId} onPress={() => setCategoryId(undefined)} />
        {all.map((c) => (
          <CategoryChip key={c.id} label={c.name} icon={c.icon} active={categoryId === c.id} onPress={() => setCategoryId(c.id)} />
        ))}
      </ScrollView>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="heading">{categoryId ? all.find((c) => c.id === categoryId)?.name : 'Pros near you'}</T>
        <Pressable onPress={() => setView(view === 'grid' ? 'map' : 'grid')} hitSlop={8}>
          <Row gap={1}>
            <PlatformIcon name={view === 'grid' ? 'map-outline' : 'view-grid-outline'} color={t.color.primary} size={18} />
            <T v="small" style={{ color: t.color.primary }}>{view === 'grid' ? 'Map' : 'Grid'}</T>
          </Row>
        </Pressable>
      </Row>
    </View>
  );

  if (view === 'map') {
    const techs = items.filter((i): i is Extract<DiscoveryItem, { type: 'technician' }> => i.type === 'technician' && !!i.liveLocation);
    return (
      <View style={{ flex: 1, backgroundColor: t.color.bg }}>
        <View style={{ padding: t.space(4), paddingBottom: 0 }}>{header}</View>
        <MapView
          style={{ flex: 1 }}
          showsUserLocation={!!loc}
          initialRegion={{ latitude: loc?.lat ?? 6.5244, longitude: loc?.lng ?? 3.3792, latitudeDelta: 0.12, longitudeDelta: 0.12 }}
        >
          {techs.map((tech) => (
            <Marker
              key={tech.id}
              coordinate={{ latitude: tech.liveLocation!.lat, longitude: tech.liveLocation!.lng }}
              title={`${tech.name}${tech.label ? ' · Promoted' : ''}`}
              description={`${tech.category.name} · from ${formatMoney(tech.startingPriceMinor)}`}
              onCalloutPress={() => router.push(`/technician/${tech.id}`)}
            >
              <View style={{ backgroundColor: t.color.surface, borderRadius: 100, padding: 6, borderWidth: 2, borderColor: tech.label ? t.color.promoted : t.color.primary }}>
                <MaterialCommunityIcons name={tech.category.icon as any} size={18} color={t.color.primary} />
              </View>
            </Marker>
          ))}
        </MapView>
      </View>
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: t.color.bg }}
      contentContainerStyle={{ padding: t.space(4), gap: t.space(3) }}
      data={rows}
      keyExtractor={(row) => row.map((i) => (i.type === 'technician' ? i.id : `ad-${i.ad.id}`)).join('|')}
      ListHeaderComponent={header}
      ListEmptyComponent={results.isLoading ? <Loading /> : <Empty title="No technicians nearby yet" body="Try another category or widen your area." />}
      refreshing={results.isRefetching}
      onRefresh={() => results.refetch()}
      renderItem={({ item: row }) => (
        <Row gap={3} style={{ alignItems: 'stretch' }}>
          {row.map((it) =>
            it.type === 'technician' ? (
              <TechnicianTile key={it.id} item={it} onPress={() => router.push(`/technician/${it.id}`)} />
            ) : (
              <SponsoredTile key={it.ad.id} item={it} />
            ),
          )}
          {row.length === 1 && row[0].type === 'technician' ? <View style={{ flex: 1 }} /> : null}
        </Row>
      )}
    />
  );
}

function CategoryChip({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={{ alignItems: 'center', width: 76, gap: 6 }} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <View style={{ width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? t.color.primary : t.color.surface }}>
        <MaterialCommunityIcons name={icon as any} size={26} color={active ? t.color.primaryText : t.color.primary} />
      </View>
      <T v="tiny" numberOfLines={2} style={{ textAlign: 'center' }}>{label}</T>
    </Pressable>
  );
}
