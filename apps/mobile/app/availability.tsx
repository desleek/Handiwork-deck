import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { Button, Card, colors, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Availability {
  timezone: string;
  availableNow: boolean;
  weekly: { day: number; start: string; end: string }[];
  timeOff: { id: string; starts_at: string; ends_at: string; reason: string | null }[];
}

/** Section 4 availability calendar: weekly working hours plus time off. */
export default function AvailabilityScreen() {
  const { data, error, loading, reload } = useApi<Availability>('/technicians/me/availability');
  const [days, setDays] = useState<{ on: boolean; start: string; end: string }[]>(DAYS.map(() => ({ on: false, start: '08:00', end: '18:00' })));
  const [timezone, setTimezone] = useState('Africa/Lagos');
  const [offFrom, setOffFrom] = useState('');
  const [offTo, setOffTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (!data) return;
    setTimezone(data.timezone);
    setDays(
      DAYS.map((_, i) => {
        const slot = data.weekly.find((w) => w.day === i);
        return slot ? { on: true, start: slot.start, end: slot.end } : { on: false, start: '08:00', end: '18:00' };
      }),
    );
  }, [data]);

  if (loading && !data) return <Loading />;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(
      () =>
        api('/technicians/me/availability', {
          method: 'PUT',
          body: { timezone, weekly: days.flatMap((d, day) => (d.on ? [{ day, start: d.start, end: d.end }] : [])) },
        }),
      'Availability saved',
    );

  return (
    <Screen>
      <Card>
        <Text style={{ fontWeight: '700', color: data?.availableNow ? colors.success : colors.ink }}>
          {data?.availableNow ? 'You are within working hours now' : 'You are outside working hours now'}
        </Text>
        <Muted>You're only matched to jobs (and instant-bookable) during these hours. No days switched on means no fixed hours.</Muted>
      </Card>
      <Field label="Time zone" value={timezone} onChangeText={setTimezone} autoCapitalize="none" />
      {days.map((d, i) => (
        <Card key={i}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.label}>{DAYS[i]}</Text>
            <Switch value={d.on} onValueChange={(on) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, on } : x)))} />
          </View>
          {d.on && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="From (HH:MM)" value={d.start} onChangeText={(v) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, start: v } : x)))} />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="To (HH:MM)" value={d.end} onChangeText={(v) => setDays((ds) => ds.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
              </View>
            </View>
          )}
        </Card>
      ))}
      <Button title="Save weekly hours" loading={busy} onPress={save} />

      <Card>
        <Text style={styles.label}>Time off</Text>
        {data?.timeOff.map((o) => (
          <View key={o.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Muted>
              {new Date(o.starts_at).toLocaleString()} → {new Date(o.ends_at).toLocaleString()}
              {o.reason ? ` · ${o.reason}` : ''}
            </Muted>
            <Pressable onPress={() => run(() => api(`/technicians/me/time-off/${o.id}`, { method: 'DELETE' }), 'Removed')}>
              <Text style={{ color: colors.danger }}>Remove</Text>
            </Pressable>
          </View>
        ))}
        <Field label="From (YYYY-MM-DD HH:MM)" value={offFrom} onChangeText={setOffFrom} placeholder="2026-12-24 00:00" />
        <Field label="To (YYYY-MM-DD HH:MM)" value={offTo} onChangeText={setOffTo} placeholder="2026-12-27 00:00" />
        <Button
          title="Add time off"
          variant="secondary"
          disabled={!offFrom || !offTo}
          onPress={() =>
            run(async () => {
              const startsAt = new Date(offFrom.replace(' ', 'T'));
              const endsAt = new Date(offTo.replace(' ', 'T'));
              if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error('Use the format YYYY-MM-DD HH:MM');
              await api('/technicians/me/time-off', { body: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } });
              setOffFrom('');
              setOffTo('');
            }, 'Time off added')
          }
        />
      </Card>
      {msg ? <Muted>{msg}</Muted> : null}
      <ErrorText error={error ?? err} />
    </Screen>
  );
}
