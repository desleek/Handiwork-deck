import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, ApiError } from '../../src/api/client';
import type { JobSummary } from '../../src/api/types';
import { Banner, Button, Empty, Loading, PlatformIcon, Row, Segmented, T, Tag } from '../../src/components/ui';
import { useMe } from '../../src/lib/auth';
import { startBroadcasting, stopBroadcasting } from '../../src/lib/location';
import { formatMoney } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

type Tab = 'new' | 'active' | 'done';

function when(j: JobSummary) {
  if (!j.scheduled_for) return 'As soon as possible';
  const d = new Date(j.scheduled_for);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function ago(iso: string) {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/**
 * Technician home: availability switch (drives live location, Section 9), earnings at a glance,
 * and the job inbox — new requests to accept, active jobs (marigold when it's their turn), history.
 */
export default function TechnicianHome() {
  const t = useTheme();
  const me = useMe();
  const [tab, setTab] = useState<Tab>('new');
  const [busy, setBusy] = useState(false);
  const profile = useQuery({ queryKey: ['tech-profile'], queryFn: () => api('/technician/profile') });
  const earnings = useQuery({ queryKey: ['tech-earnings'], queryFn: () => api('/technician/earnings') });
  const supplies = useQuery({ queryKey: ['supplies-status'], queryFn: () => api('/supplies/status') });
  const active = useQuery({ queryKey: ['jobs', 'active'], queryFn: () => api<JobSummary[]>('/jobs', { query: { scope: 'active' } }), refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ['jobs', 'history'], queryFn: () => api<JobSummary[]>('/jobs', { query: { scope: 'history' } }), enabled: tab === 'done' });

  const online = !!profile.data?.profile?.is_online;
  const verified = profile.data?.profile?.verification_status === 'verified';
  const requests = (active.data ?? []).filter((j) => j.status === 'requested');
  const ongoing = (active.data ?? [])
    .filter((j) => j.status !== 'requested')
    .sort((a, b) => Number(b.action_required_from === 'technician') - Number(a.action_required_from === 'technician'));
  const list = tab === 'new' ? requests : tab === 'active' ? ongoing : history.data ?? [];
  const loading = tab === 'done' ? history.isLoading : active.isLoading;

  const respond = useMutation({
    mutationFn: ({ jobId, accept }: { jobId: string; accept: boolean }) => api(`/jobs/${jobId}/${accept ? 'accept' : 'decline'}`, { body: {} }),
    onSuccess: (_d, v) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      if (v.accept) router.push(`/job/${v.jobId}`);
    },
    onError: (e: ApiError) => Alert.alert('Could not respond', e.message),
  });

  const toggle = async () => {
    const next = !online;
    setBusy(true);
    try {
      if (next) {
        const pos = await startBroadcasting();
        if (!pos) return;
        await api('/technician/online', { body: { online: true, ...pos } });
      } else {
        await stopBroadcasting();
        await api('/technician/online', { body: { online: false } });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: ['tech-profile'] });
    } catch (e: any) {
      Alert.alert('Could not change status', e.message);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <View>
      {/* Dark band: status and money */}
      <SafeAreaView edges={['top']} style={{ backgroundColor: t.color.ink }}>
        <View style={{ paddingHorizontal: t.space(5), paddingTop: t.space(3), paddingBottom: t.space(5), gap: t.space(4) }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ gap: 2 }}>
              <T v="small" color={t.color.inkMuted}>Hi {me.full_name.split(' ')[0]}</T>
              <T v="title" color="#FFFFFF" style={{ fontSize: 24 }}>Your jobs</T>
            </View>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: online, disabled: busy || !verified }}
              accessibilityLabel="Available for new jobs"
              disabled={busy || !verified}
              onPress={toggle}
              style={{ flexDirection: 'row', alignItems: 'center', gap: t.space(2.5), height: 44, borderRadius: 999, paddingLeft: 14, paddingRight: 8, backgroundColor: online ? t.color.heroRaised : t.color.inkRaised, opacity: verified ? 1 : 0.6 }}
            >
              <T v="smallStrong" color="#FFFFFF" style={{ fontSize: 14 }}>{online ? 'Available' : 'Offline'}</T>
              <View style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: online ? t.color.online : '#6B7770', justifyContent: 'center', paddingHorizontal: 3 }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF', alignSelf: online ? 'flex-end' : 'flex-start' }} />
              </View>
            </Pressable>
          </Row>
          <Row gap={2.5}>
            <Stat label="Earned, last 30 days" value={earnings.data ? formatMoney(earnings.data.last_30_days_minor) : '—'} />
            <Stat label="Wallet balance" value={earnings.data ? formatMoney(earnings.data.balanceMinor) : '—'} accent onPress={() => router.push('/(technician)/wallet')} />
          </Row>
        </View>
      </SafeAreaView>

      <View style={{ padding: t.space(5), paddingBottom: t.space(1), gap: t.space(3.5) }}>
        {!verified && profile.data ? (
          <Banner text="Finish your profile (ID, services, coverage area) on the Profile tab. You can go online once an admin verifies you." />
        ) : null}
        {supplies.data?.enabled ? <Button size="md" kind="secondary" icon="cart-outline" title="Buy supplies at pro prices" onPress={() => router.push('/supplies')} /> : null}
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { key: 'new', label: requests.length ? `New (${requests.length})` : 'New' },
            { key: 'active', label: ongoing.length ? `Active (${ongoing.length})` : 'Active' },
            { key: 'done', label: 'Done' },
          ]}
        />
      </View>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: t.color.bg }}
      contentContainerStyle={{ paddingBottom: t.space(6) }}
      data={list}
      keyExtractor={(j) => j.id}
      ListHeaderComponent={header}
      refreshing={active.isRefetching}
      onRefresh={() => {
        active.refetch();
        earnings.refetch();
        if (tab === 'done') history.refetch();
      }}
      ItemSeparatorComponent={() => <View style={{ height: t.space(3) }} />}
      ListEmptyComponent={
        loading ? (
          <Loading />
        ) : tab === 'new' ? (
          <Empty icon="tray-arrow-down" title="No new requests" body={online ? 'You are online. New bookings will show up here.' : 'Go online to appear on the map and get bookings.'} />
        ) : tab === 'active' ? (
          <Empty icon="briefcase-outline" title="No active jobs" />
        ) : (
          <Empty icon="check" title="Nothing finished yet" />
        )
      }
      renderItem={({ item }) => (
        <View style={{ paddingHorizontal: t.space(5) }}>
          {tab === 'new' ? (
            <RequestCard job={item} busy={respond.isPending && respond.variables?.jobId === item.id} onAccept={() => respond.mutate({ jobId: item.id, accept: true })} onDecline={() => respond.mutate({ jobId: item.id, accept: false })} />
          ) : tab === 'active' ? (
            <ActiveCard job={item} />
          ) : (
            <DoneRow job={item} />
          )}
        </View>
      )}
    />
  );
}

function Stat({ label, value, accent, onPress }: { label: string; value: string; accent?: boolean; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable disabled={!onPress} onPress={onPress} accessibilityRole={onPress ? 'button' : undefined} style={{ flex: 1, backgroundColor: t.color.inkRaised, borderRadius: t.radius.md, paddingVertical: t.space(3), paddingHorizontal: t.space(3.5), gap: 2 }}>
      <T v="tiny" color={t.color.inkMuted} numberOfLines={1}>{label}</T>
      <T v="heading" color={accent ? t.color.accent : '#FFFFFF'} style={[t.font.money, { fontSize: 21, lineHeight: 26 }]} numberOfLines={1}>{value}</T>
    </Pressable>
  );
}

function RequestCard({ job, busy, onAccept, onDecline }: { job: JobSummary; busy: boolean; onAccept: () => void; onDecline: () => void }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.color.surface, borderRadius: t.radius.lg, borderWidth: job.is_fast_track ? 1.5 : 1, borderColor: job.is_fast_track ? t.color.accent : t.color.border, padding: t.space(4), gap: t.space(3) }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row gap={1.5} style={{ flex: 1 }}>
          <MaterialCommunityIcons name={job.category_icon as any} size={18} color={t.color.primary} />
          <T v="label" color={t.color.primary} numberOfLines={1} style={{ flex: 1 }}>{job.category_name}</T>
        </Row>
        {job.is_fast_track ? <Tag label="Urgent" tone="danger" icon="flash" /> : <T v="tiny" muted>{ago(job.created_at)}</T>}
      </Row>
      <Pressable onPress={() => router.push(`/job/${job.id}`)} accessibilityRole="link" style={{ gap: 4 }}>
        <T v="bodyStrong" style={{ fontSize: 17, lineHeight: 23 }} numberOfLines={3}>{job.description}</T>
        <T v="small" muted>{job.counterpart_name}</T>
      </Pressable>
      <Row gap={1.5}>
        <PlatformIcon name="clock-outline" size={16} color={t.color.textMuted} />
        <T v="small">{when(job)}</T>
      </Row>
      <Row gap={2.5}>
        <Button style={{ flex: 1 }} kind="outline" title="Decline" disabled={busy} onPress={onDecline} />
        <Button style={{ flex: 2 }} title="Accept job" loading={busy} onPress={onAccept} />
      </Row>
    </View>
  );
}

function ActiveCard({ job }: { job: JobSummary }) {
  const t = useTheme();
  const myTurn = job.action_required_from === 'technician';
  const waitingOn = job.action_required_from === 'customer' ? 'Waiting on customer' : job.action_required_from === 'admin' ? 'With Handiwork-Deck' : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/job/${job.id}`)}
      style={({ pressed }) => ({ backgroundColor: t.color.surface, borderRadius: t.radius.lg, borderWidth: myTurn ? 1.5 : 1, borderColor: myTurn ? t.color.accent : t.color.border, padding: t.space(4), gap: t.space(2), opacity: pressed ? 0.9 : 1 })}
    >
      {myTurn ? (
        <Tag label={`Your turn${job.action_required_reason ? ` · ${job.action_required_reason}` : ''}`} tone="warning" />
      ) : waitingOn ? (
        <Tag label={waitingOn} tone="neutral" />
      ) : ['funded', 'en_route', 'in_progress'].includes(job.status) ? (
        <Tag label="Paid · money held" tone="success" icon="shield-check-outline" />
      ) : null}
      <T v="bodyStrong" style={{ fontSize: 17 }} numberOfLines={2}>{job.description}</T>
      <T v="small" muted numberOfLines={1}>
        {job.counterpart_name} · {job.category_name}
        {job.quote_total_minor ? ` · ${formatMoney(job.quote_total_minor)}` : ''}
      </T>
    </Pressable>
  );
}

function DoneRow({ job }: { job: JobSummary }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/job/${job.id}`)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space(3), backgroundColor: t.color.surface, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.border, padding: t.space(3.5) }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <T v="bodyStrong" numberOfLines={1}>{job.description}</T>
        <T v="small" muted numberOfLines={1}>{job.counterpart_name} · {job.status === 'completed' ? 'Completed' : job.status.replace('_', ' ')}</T>
      </View>
      {job.quote_total_minor ? <T v="bodyStrong" style={t.font.money}>{formatMoney(job.quote_total_minor)}</T> : null}
    </Pressable>
  );
}
