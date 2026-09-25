import Ionicons from '@expo/vector-icons/Ionicons';
import { SERVICE_SEGMENTS, type ServiceSegment } from '@handiwork/shared';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import MapView, { Callout, Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AdSlot } from '@/components/AdSlot';
import { TechCard } from '@/components/TechCard';
import { Button, Chip, colors, ErrorText, Loading, Muted, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { type Category, iconFor, SEGMENT_LABEL } from '@/lib/categories';
import type { DiscoverResult, TechCardData } from '@/lib/discover';
import { useApi } from '@/lib/useApi';

const RADII = [5, 10, 25, 50];

export default function Discover() {
  const { data: cats } = useApi<{ categories: Category[] }>('/categories');
  const { data: pending } = useApi<{ jobs: { id: string; ref: string; title: string }[] }>('/me/pending-reviews');
  const [segment, setSegment] = useState<ServiceSegment>('household_office');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [radius, setRadius] = useState(25);
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // Location filter: the customer's current position (if permitted).
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    })().catch(() => {});
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (categoryId) p.set('categoryId', String(categoryId));
    else p.set('segment', segment);
    if (here) {
      p.set('lat', String(here.lat));
      p.set('lng', String(here.lng));
      p.set('radiusKm', String(radius));
    }
    return `/discover?${p.toString()}`;
  }, [categoryId, segment, here, radius]);

  const load = useCallback(async () => {
    try {
      setResult(await api<DiscoverResult>(query));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useFocusEffect(
    useCallback(() => {
      void load();
      // On the map, refresh so live technician positions keep moving.
      if (view !== 'map') return;
      const t = setInterval(load, 30_000);
      return () => clearInterval(t);
    }, [load, view]),
  );

  const categories = cats?.categories.filter((c) => c.segment === segment) ?? [];
  const selected = cats?.categories.find((c) => c.id === categoryId);
  const all: TechCardData[] = [...(result?.boosted ?? []), ...(result?.organic ?? [])];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['left', 'right']}>
      {/* Supercategory switch */}
      <View style={{ flexDirection: 'row', padding: 12, paddingBottom: 0, gap: 8 }}>
        {SERVICE_SEGMENTS.map((s) => (
          <Pressable
            key={s}
            onPress={() => {
              setSegment(s);
              setCategoryId(null);
            }}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: segment === s ? colors.ink : '#fff', borderWidth: 1, borderColor: colors.line }}
          >
            <Text style={{ textAlign: 'center', fontWeight: '600', fontSize: 12, color: segment === s ? '#fff' : colors.ink }}>{SEGMENT_LABEL[s]}</Text>
          </Pressable>
        ))}
      </View>

      {/* Icon-first category strip */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12, gap: 10 }} style={{ flexGrow: 0 }}>
        {categories.map((c) => {
          const on = c.id === categoryId;
          return (
            <Pressable key={c.id} onPress={() => setCategoryId(on ? null : c.id)} style={{ width: 76, alignItems: 'center', gap: 6 }}>
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? colors.primary : '#fff',
                  borderWidth: 1,
                  borderColor: on ? colors.primary : colors.line,
                }}
              >
                <Ionicons name={iconFor(c.icon)} size={26} color={on ? '#fff' : colors.primary} />
              </View>
              <Text numberOfLines={2} style={{ fontSize: 11, textAlign: 'center', color: colors.ink }}>
                {c.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Location + view filters */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 6, flexWrap: 'wrap' }}>
        {here ? RADII.map((r) => <Chip key={r} label={`${r} km`} selected={radius === r} onPress={() => setRadius(r)} />) : <Muted>Enable location to see who's nearby</Muted>}
        <View style={{ flex: 1 }} />
        <Chip label="List" selected={view === 'list'} onPress={() => setView('list')} />
        <Chip label="Map" selected={view === 'map'} onPress={() => setView('map')} />
      </View>

      {!!pending?.jobs.length && (
        <Pressable onPress={() => router.push(`/job/${pending.jobs[0]!.id}`)} style={{ margin: 12, marginBottom: 0, padding: 12, borderRadius: 10, backgroundColor: '#FEF3C7' }}>
          <Text style={{ fontWeight: '600', color: '#92400E' }}>Review needed before your next booking</Text>
          <Text style={{ color: '#92400E' }}>Tap to rate #{pending.jobs[0]!.ref} — {pending.jobs[0]!.title}</Text>
        </Pressable>
      )}

      {loading && !result ? (
        <Loading />
      ) : view === 'map' ? (
        <TechMap techs={all} here={here} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
          <ErrorText error={error} />
          {!!result?.boosted.length && (
            <>
              <Text style={styles.label}>Promoted</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 }}>
                {result.boosted.map((t) => <TechCard key={t.id} tech={t} />)}
              </View>
            </>
          )}
          {!!result?.organic.length && (
            <>
              {!!result.boosted.length && <Text style={styles.label}>{selected ? selected.name : 'Technicians'} near you</Text>}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 }}>
                {result.organic.map((t) => <TechCard key={t.id} tech={t} />)}
              </View>
            </>
          )}
          {!all.length && <Muted>No available technicians match yet. Post your job and we'll find someone.</Muted>}
          {selected && (
            <Button
              title={selected.is_other ? 'Describe your custom request' : `Post a ${selected.name} job to everyone`}
              variant="secondary"
              onPress={() => router.push({ pathname: '/post-job', params: { categoryId: String(selected.id), name: selected.name, isOther: selected.is_other ? '1' : '' } })}
            />
          )}
          <AdSlot categoryId={categoryId ?? undefined} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function TechMap({ techs, here }: { techs: TechCardData[]; here: { lat: number; lng: number } | null }) {
  const live = techs.filter((t) => t.livePosition);
  const center = here ?? live[0]?.livePosition ?? { lat: 6.5244, lng: 3.3792 }; // Lagos fallback
  return (
    <View style={{ flex: 1, margin: 12, borderRadius: 14, overflow: 'hidden' }}>
      <MapView
        style={{ flex: 1 }}
        showsUserLocation
        initialRegion={{ latitude: center.lat, longitude: center.lng, latitudeDelta: 0.2, longitudeDelta: 0.2 }}
      >
        {live.map((t) => (
          <Marker key={t.id} coordinate={{ latitude: t.livePosition!.lat, longitude: t.livePosition!.lng }} pinColor={t.boosted ? colors.primary : colors.success}>
            <Callout onPress={() => router.push(`/technician/${t.id}`)}>
              <Text style={{ fontWeight: '600' }}>{t.fullName}</Text>
              <Text>
                {t.category.name} · ★ {t.rating.count ? t.rating.avg.toFixed(1) : 'New'}
              </Text>
            </Callout>
          </Marker>
        ))}
      </MapView>
      <View style={{ position: 'absolute', bottom: 10, left: 10, backgroundColor: '#fff', borderRadius: 8, padding: 8 }}>
        <Muted>{live.length ? `${live.length} technician${live.length > 1 ? 's' : ''} online now` : 'No technicians online nearby right now'}</Muted>
      </View>
    </View>
  );
}
