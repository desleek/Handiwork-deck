import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, TextInput } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { Banner, Button, Card, Row, Screen, T } from '../../src/components/ui';
import { currentPosition, ensureForegroundLocation } from '../../src/lib/location';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

export default function Book() {
  const t = useTheme();
  const { technicianId, categoryId, construction } = useLocalSearchParams<{ technicianId: string; categoryId: string; construction?: string }>();
  const isConstruction = construction === '1';
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [instant, setInstant] = useState(true);
  const [fastTrack, setFastTrack] = useState(false);
  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3.5), color: t.color.text, fontSize: 16, borderWidth: 1, borderColor: t.color.border };

  const book = useMutation({
    mutationFn: async () => {
      const loc = (await ensureForegroundLocation('Share the job location so the technician can find you.')) ? await currentPosition() : null;
      return api('/jobs', {
        body: { technicianId, categoryId, bookingType: instant ? 'instant' : 'request', description, address, lat: loc?.lat, lng: loc?.lng, fastTrack },
      });
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
      router.replace(`/job/${job.id}`);
    },
  });

  const err = book.error as ApiError | null;
  return (
    <Screen>
      {err?.code === 'REVIEW_REQUIRED' ? (
        <Banner text="Please rate your last completed job first." />
      ) : err ? (
        <Banner tone="danger" text={err.message} />
      ) : null}
      <T v="small" muted>What needs doing?</T>
      <TextInput value={description} onChangeText={setDescription} multiline placeholder={isConstruction ? 'e.g. 3-bedroom bungalow, foundation to roofing, plot size 50×100ft' : 'e.g. Kitchen sink is leaking under the cabinet'} placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 110, textAlignVertical: 'top' }]} />
      <T v="small" muted>Address</T>
      <TextInput value={address} onChangeText={setAddress} placeholder="Street, area, city" placeholderTextColor={t.color.textMuted} style={input} />
      {isConstruction ? (
        <Card>
          <T v="heading">How construction jobs work</T>
          <T v="small" muted>1. The technician quotes a fee to inspect and measure the site, and you pay it to book the visit.</T>
          <T v="small" muted>2. After the visit they send an itemized Bill of Quantities with milestones (e.g. foundation, walls, roofing).</T>
          <T v="small" muted>3. You fund one milestone at a time; each is released only when you sign it off.</T>
        </Card>
      ) : (
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }}>Instant book</T>
          <Switch value={instant} onValueChange={setInstant} />
        </Row>
        <T v="small" muted>{instant ? 'The technician goes straight to sending you an itemized quote.' : 'The technician first accepts or declines your request.'}</T>
        <Row style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }}>Urgent (Fast Track)</T>
          <Switch value={fastTrack} onValueChange={setFastTrack} />
        </Row>
        <T v="small" muted>Fast Track shortens response deadlines if you challenge a parts price.</T>
      </Card>
      )}
      <T v="small" muted>Your phone number stays hidden until you approve and pay. Chat in the app in the meantime.</T>
      <Button title={isConstruction ? 'Request site visit' : 'Send booking'} loading={book.isPending} disabled={description.trim().length < 10 || address.trim().length < 5} onPress={() => book.mutate()} />
    </Screen>
  );
}
