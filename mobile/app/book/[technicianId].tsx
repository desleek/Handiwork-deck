import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Switch, TextInput, View } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { Banner, Button, Card, Chip, Divider, Note, PlatformIcon, Row, Screen, ScreenHeader, Section, T } from '../../src/components/ui';
import { currentPosition, ensureForegroundLocation } from '../../src/lib/location';
import { formatMoney } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

const SLOT_HOURS = [10, 12, 14, 16];
type Day = 'now' | 'today' | 'tomorrow';

function dayLabel(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });
}
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * Booking (instant by default): problem → when → where → what it costs. Nothing is charged here;
 * the customer approves the itemized quote before paying.
 */
export default function Book() {
  const t = useTheme();
  const { technicianId, categoryId, construction, name, service, laborMinor } = useLocalSearchParams<{
    technicianId: string;
    categoryId: string;
    construction?: string;
    name?: string;
    service?: string;
    laborMinor?: string;
  }>();
  const isConstruction = construction === '1';
  const firstName = (name ?? 'the technician').split(' ')[0];

  // Today's slots that are still at least an hour away.
  const todaySlots = useMemo(() => SLOT_HOURS.filter((h) => h > new Date().getHours() + 1), []);
  const [day, setDay] = useState<Day>(todaySlots.length ? 'today' : 'tomorrow');
  const slots = day === 'today' ? todaySlots : SLOT_HOURS;
  const [hour, setHour] = useState<number>((todaySlots.length ? todaySlots : SLOT_HOURS)[0]!);
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [instant, setInstant] = useState(true);
  const [fastTrack, setFastTrack] = useState(false);

  const scheduledFor = useMemo(() => {
    if (day === 'now') return undefined;
    const d = new Date();
    if (day === 'tomorrow') d.setDate(d.getDate() + 1);
    d.setHours(slots.includes(hour) ? hour : slots[0]!, 0, 0, 0);
    return d;
  }, [day, hour, slots]);
  const whenLabel = day === 'now' ? 'ASAP' : `${day === 'today' ? 'Today' : 'Tomorrow'} ${hh(scheduledFor!.getHours())}`;

  const input = [t.font.body, { backgroundColor: t.color.surface, borderRadius: t.radius.md, padding: t.space(3.5), color: t.color.text, fontSize: 16, borderWidth: 1, borderColor: t.color.border }];

  const book = useMutation({
    mutationFn: async () => {
      const loc = (await ensureForegroundLocation('Share the job location so the technician can find you.')) ? await currentPosition() : null;
      return api('/jobs', {
        body: {
          technicianId,
          categoryId,
          bookingType: instant ? 'instant' : 'request',
          description,
          address,
          lat: loc?.lat,
          lng: loc?.lng,
          fastTrack,
          scheduledFor: scheduledFor?.toISOString(),
        },
      });
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      router.replace(`/job/${job.id}`);
    },
  });

  const err = book.error as ApiError | null;
  const ready = description.trim().length >= 10 && address.trim().length >= 5;

  return (
    <Screen
      edges={['top', 'bottom']}
      header={<ScreenHeader title={`Book ${firstName}`} subtitle={service} />}
      footer={
        <>
          {!ready ? <T v="tiny" muted style={{ textAlign: 'center' }}>Add a short description and your address to continue.</T> : null}
          <Button title={isConstruction ? `Request site visit · ${whenLabel}` : `Confirm booking · ${whenLabel}`} loading={book.isPending} disabled={!ready} onPress={() => book.mutate()} />
        </>
      }
    >
      {err?.code === 'REVIEW_REQUIRED' ? <Banner text="Please rate your last completed job first." /> : err ? <Banner tone="danger" text={err.message} /> : null}

      <Section title="What's the problem?">
        <TextInput
          value={description}
          onChangeText={setDescription}
          multiline
          accessibilityLabel="Describe the problem"
          placeholder={isConstruction ? 'e.g. 3-bedroom bungalow, foundation to roofing, plot size 50×100ft' : 'e.g. Inverter beeps and isn’t charging the batteries'}
          placeholderTextColor={t.color.textMuted}
          style={[input, { minHeight: 104, textAlignVertical: 'top' }]}
        />
        <T v="tiny" muted>The more detail, the more accurate the quote. You can send photos in chat once booked.</T>
      </Section>

      <Section title={isConstruction ? 'When can they visit?' : 'When?'}>
        <Row gap={2}>
          {!isConstruction ? <Chip label="Now" sub="ASAP" selected={day === 'now'} onPress={() => setDay('now')} /> : null}
          {todaySlots.length ? <Chip label="Today" sub={dayLabel(0)} selected={day === 'today'} onPress={() => { setDay('today'); setHour(todaySlots[0]!); }} /> : null}
          <Chip label="Tomorrow" sub={dayLabel(1)} selected={day === 'tomorrow'} onPress={() => setDay('tomorrow')} />
        </Row>
        {day !== 'now' ? (
          <Row gap={2}>
            {slots.map((h) => (
              <Chip key={h} label={hh(h)} solid selected={(slots.includes(hour) ? hour : slots[0]) === h} onPress={() => setHour(h)} />
            ))}
          </Row>
        ) : (
          <Note tone="attention" icon="clock-outline" text={`${firstName} gets your request straight away. If they can't come, you can book someone else nearby.`} />
        )}
      </Section>

      <Section title="Where?">
        <Row gap={2.5} style={[input[1] as object, { paddingVertical: 0, paddingLeft: t.space(3.5) }]}>
          <PlatformIcon name="map-marker-outline" size={22} color={t.color.primary} />
          <TextInput
            value={address}
            onChangeText={setAddress}
            accessibilityLabel="Address"
            placeholder="House number, street, area"
            placeholderTextColor={t.color.textMuted}
            style={[t.font.body, { flex: 1, minHeight: 52, color: t.color.text, fontSize: 16 }]}
          />
        </Row>
        <Row gap={1.5}>
          <PlatformIcon name="lock-outline" size={14} color={t.color.textMuted} />
          <T v="tiny" muted style={{ flex: 1 }}>Your phone number stays hidden until the job is paid. Chat in the app until then.</T>
        </Row>
      </Section>

      {isConstruction ? (
        <Card>
          <T v="heading">How construction jobs work</T>
          <T v="small" muted>1. The technician quotes a fee to inspect and measure the site, and you pay it to book the visit.</T>
          <T v="small" muted>2. After the visit they send an itemized Bill of Quantities with milestones (e.g. foundation, walls, roofing).</T>
          <T v="small" muted>3. You fund one milestone at a time; each is released only when you sign it off.</T>
        </Card>
      ) : (
        <>
          <Card>
            <T v="heading">What you'll pay</T>
            <Row style={{ justifyContent: 'space-between' }}>
              <T>Labor (agreed rate)</T>
              <T v="bodyStrong" style={t.font.money}>{laborMinor ? formatMoney(Number(laborMinor)) : 'In the quote'}</T>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <T>Parts</T>
              <T muted>Quoted after diagnosis</T>
            </Row>
            <Divider />
            <T v="small" muted>Nothing is charged now. You approve the full quote, parts and all, before you pay.</T>
          </Card>

          <Card>
            <OptionRow
              title="Urgent (Fast Track)"
              body="Shorter response deadlines if you challenge a parts price."
              value={fastTrack}
              onChange={setFastTrack}
            />
            <Divider />
            <OptionRow
              title="Instant booking"
              body={instant ? `${firstName} goes straight to diagnosing and quoting.` : `${firstName} first accepts or declines your request.`}
              value={instant}
              onChange={setInstant}
            />
          </Card>
        </>
      )}
      <View style={{ height: t.space(2) }} />
    </Screen>
  );
}

function OptionRow({ title, body, value, onChange }: { title: string; body: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <Row gap={3}>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="bodyStrong">{title}</T>
        <T v="small" muted>{body}</T>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} trackColor={{ true: t.color.primaryFill, false: t.color.borderStrong }} thumbColor="#FFFFFF" />
    </Row>
  );
}
