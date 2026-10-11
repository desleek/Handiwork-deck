import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../src/api/client';
import type { Category, DiscoveryItem, JobSummary } from '../../src/api/types';
import { SponsoredTile, TechnicianTile } from '../../src/components/DiscoveryTiles';
import { Empty, IconButton, Loading, PlatformIcon, Row, T } from '../../src/components/ui';
import { useMe } from '../../src/lib/auth';
import { currentPosition, ensureForegroundLocation } from '../../src/lib/location';
import { formatMoney } from '../../src/lib/money';
import { useTheme } from '../../src/theme';

const GRID_SIZE = 7; // 7 services + "All services" fills two rows of four

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * Icon-first discovery (Section 3): a "your turn" card for any job waiting on the customer,
 * a service grid, then verified technicians nearby (or the live map).
 */
export default function Home() {
  const t = useTheme();
  const me = useMe();
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [area, setArea] = useState<string | null>(null);

  useEffect(() => {
    ensureForegroundLocation('We use your location to show technicians near you. It is never shared with technicians.').then(async (ok) => {
      if (!ok) return;
      const pos = await currentPosition();
      setLoc(pos);
      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude: pos.lat, longitude: pos.lng });
        setArea(place?.district ?? place?.subregion ?? place?.city ?? null);
      } catch {
        // The area label is a nicety; "Near you" is fine without it.
      }
    });
  }, []);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ household_office: Category[]; construction: Category[] }>('/categories') });
  const activeJobs = useQuery({ queryKey: ['jobs', 'active'], queryFn: () => api<JobSummary[]>('/jobs', { query: { scope: 'active' } }) });
  const results = useQuery({
    queryKey: ['discover', categoryId, loc?.lat, loc?.lng],
    queryFn: () => api<{ items: DiscoveryItem[] }>('/technicians', { query: { categoryId, lat: loc?.lat, lng: loc?.lng } }),
    refetchInterval: view === 'map' ? 20_000 : false, // live positions on the map
  });

  const all = useMemo(() => [...(categories.data?.household_office ?? []), ...(categories.data?.construction ?? [])], [categories.data]);
  const q = search.trim().toLowerCase();
  const matching = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  const grid = q || showAll ? matching : matching.slice(0, GRID_SIZE);
  const selected = all.find((c) => c.id === categoryId);
  const yourTurn = (activeJobs.data ?? []).find((j) => j.action_required_from === 'customer');
  const items = results.data?.items ?? [];
  const firstName = me.full_name.split(' ')[0];

  const header = (
    <View style={{ gap: t.space(5), paddingBottom: t.space(1) }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ gap: 2 }}>
          <T v="small" muted>{greeting()}, {firstName}</T>
          <Row gap={1.5}>
            <PlatformIcon name="map-marker-outline" size={18} color={t.color.primary} />
            <T v="bodyStrong" style={{ fontSize: 16 }}>{area ?? 'Near you'}</T>
          </Row>
        </View>
        <IconButton icon={view === 'list' ? 'map-outline' : 'view-grid-outline'} label={view === 'list' ? 'Show map' : 'Show list'} onPress={() => setView(view === 'list' ? 'map' : 'list')} />
      </Row>

      <T v="display">What needs fixing today?</T>

      <Row gap={2.5} style={{ backgroundColor: t.color.surface, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.md, paddingHorizontal: t.space(4), height: 52 }}>
        <PlatformIcon name="magnify" size={20} color={t.color.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Inverter, leaking tap, AC service…"
          placeholderTextColor={t.color.textMuted}
          accessibilityLabel="Search services"
          returnKeyType="search"
          style={[t.font.body, { flex: 1, color: t.color.text, fontSize: 16, paddingVertical: 0 }]}
        />
        {search ? (
          <Pressable accessibilityLabel="Clear search" hitSlop={10} onPress={() => setSearch('')}>
            <PlatformIcon name="close" size={18} color={t.color.textMuted} />
          </Pressable>
        ) : null}
      </Row>

      {me.pendingReviewJobIds.length > 0 ? (
        <ActionCard
          icon="star-outline"
          title="Rate your last job"
          body="It takes under a minute, and you can book again straight after."
          onPress={() => router.push(`/job/${me.pendingReviewJobIds[0]}/rate`)}
        />
      ) : yourTurn ? (
        <ActionCard
          icon="file-document-outline"
          title={yourTurn.status === 'quoted' ? `${yourTurn.counterpart_name.split(' ')[0]} sent your quote` : yourTurn.action_required_reason ?? 'A job needs you'}
          body={`${yourTurn.category_name}${yourTurn.quote_total_minor ? ` · ${formatMoney(yourTurn.quote_total_minor)}` : ''} · tap to review`}
          onPress={() => router.push(`/job/${yourTurn.id}`)}
        />
      ) : null}

      <View style={{ gap: t.space(3) }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">{q ? `Services matching “${search.trim()}”` : 'Services'}</T>
          {!q && all.length > GRID_SIZE ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setShowAll(!showAll)}>
              <T v="smallStrong" color={t.color.primary} style={{ fontSize: 14 }}>{showAll ? 'Show fewer' : `See all ${all.length}`}</T>
            </Pressable>
          ) : null}
        </Row>
        {categories.isLoading ? (
          <Loading />
        ) : grid.length === 0 ? (
          <T muted>No service called that yet. Try a simpler word, like “AC” or “tap”.</T>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space(2.5) }}>
            {grid.map((c) => (
              <ServiceTile key={c.id} label={c.name} icon={c.icon} active={categoryId === c.id} onPress={() => setCategoryId(categoryId === c.id ? undefined : c.id)} />
            ))}
            {!q && !showAll && all.length > GRID_SIZE ? <ServiceTile label="All services" icon="view-grid-outline" active={false} onPress={() => setShowAll(true)} /> : null}
          </View>
        )}
      </View>

      <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <T v="heading" numberOfLines={1} style={{ flex: 1 }}>{selected ? `Top rated for ${selected.name.toLowerCase()}` : 'Top rated near you'}</T>
        {selected ? (
          <Pressable hitSlop={8} onPress={() => setCategoryId(undefined)}>
            <T v="smallStrong" color={t.color.primary}>Clear</T>
          </Pressable>
        ) : null}
      </Row>
    </View>
  );

  if (view === 'map') {
    const techs = items.filter((i): i is Extract<DiscoveryItem, { type: 'technician' }> => i.type === 'technician' && !!i.liveLocation);
    return (
      <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.color.bg }}>
        <Row style={{ justifyContent: 'space-between', padding: t.space(5), paddingBottom: t.space(3) }}>
          <T v="title">{selected?.name ?? 'Technicians near you'}</T>
          <IconButton icon="view-grid-outline" label="Show list" onPress={() => setView('list')} />
        </Row>
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
              description={`${tech.category.name} · labor ${formatMoney(tech.startingPriceMinor)}`}
              onCalloutPress={() => router.push(`/technician/${tech.id}`)}
            >
              <View style={{ backgroundColor: t.color.surface, borderRadius: 100, padding: 6, borderWidth: 2, borderColor: tech.label ? t.color.promoted : t.color.primary }}>
                <MaterialCommunityIcons name={tech.category.icon as any} size={18} color={t.color.primary} />
              </View>
            </Marker>
          ))}
        </MapView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.color.bg }}>
      <FlatList
        contentContainerStyle={{ padding: t.space(5), paddingTop: t.space(3), gap: t.space(3) }}
        keyboardShouldPersistTaps="handled"
        data={items}
        keyExtractor={(i) => (i.type === 'technician' ? i.id : `ad-${i.ad.id}`)}
        ListHeaderComponent={header}
        ListEmptyComponent={
          results.isLoading ? <Loading /> : <Empty icon="account-outline" title="No technicians nearby yet" body="Try another service, or check back soon. New technicians are verified every week." />
        }
        refreshing={results.isRefetching}
        onRefresh={() => {
          results.refetch();
          activeJobs.refetch();
        }}
        renderItem={({ item, index }) =>
          item.type === 'technician' ? (
            <TechnicianTile item={item} index={index} onPress={() => router.push(`/technician/${item.id}`)} />
          ) : (
            <SponsoredTile item={item} />
          )
        }
      />
    </SafeAreaView>
  );
}

/** The green "needs you" card at the top of home. */
function ActionCard({ icon, title, body, onPress }: { icon: string; title: string; body: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: t.space(3), backgroundColor: t.color.hero, borderRadius: t.radius.lg, padding: t.space(3.5), opacity: pressed ? 0.9 : 1 })}
    >
      <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: t.color.accent, alignItems: 'center', justifyContent: 'center' }}>
        <PlatformIcon name={icon} size={20} color="#17211C" />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="bodyStrong" color={t.color.heroText} numberOfLines={1}>{title}</T>
        <T v="small" color={t.color.heroMuted} numberOfLines={1}>{body}</T>
      </View>
      <PlatformIcon name="chevron-right" size={20} color={t.color.heroText} />
    </Pressable>
  );
}

/** One square in the service grid: four per row, icon above a two-line label. */
function ServiceTile({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: '22.6%',
        minHeight: 86,
        paddingVertical: t.space(3),
        paddingHorizontal: 4,
        borderRadius: t.radius.md,
        borderWidth: active ? 1.5 : 1,
        borderColor: active ? t.color.primary : t.color.border,
        backgroundColor: active ? t.color.primarySoft : t.color.surface,
        alignItems: 'center',
        gap: t.space(2),
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <MaterialCommunityIcons name={icon as any} size={28} color={t.color.primary} />
      <T v="tiny" numberOfLines={2} style={{ textAlign: 'center' }}>{label}</T>
    </Pressable>
  );
}
