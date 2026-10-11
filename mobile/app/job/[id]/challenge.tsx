import { useMutation, useQuery } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Switch, TextInput } from 'react-native';
import { api, ApiError, uploadFile } from '../../../src/api/client';
import type { JobDetail } from '../../../src/api/types';
import { Banner, Button, Card, Row, Screen, T, Tag } from '../../../src/components/ui';
import { formatMoney, toMinor } from '../../../src/lib/money';
import { queryClient } from '../../../src/lib/offline';
import { useTheme } from '../../../src/theme';

/**
 * Price challenge (Section 6c): evidence must come from a seller in the verified registry.
 * If the seller isn't listed yet, the evidence goes to an admin for case-by-case review.
 */
export default function Challenge() {
  const t = useTheme();
  const { id, lineId } = useLocalSearchParams<{ id: string; lineId: string }>();
  const job = queryClient.getQueryData<JobDetail>(['job', id]);
  const line = job?.quote?.lines.find((l) => l.id === lineId);
  const [search, setSearch] = useState('');
  const [seller, setSeller] = useState<{ id: string; name: string } | null>(null);
  const [unlisted, setUnlisted] = useState(false);
  const [price, setPrice] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState<string | null>(null);
  const [fastTrack, setFastTrack] = useState(job?.is_fast_track ?? false);
  const input = { backgroundColor: t.color.surface, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };

  const sellers = useQuery({ queryKey: ['sellers', search], queryFn: () => api<any[]>('/sellers', { query: { search } }), enabled: !unlisted });

  const submit = useMutation({
    mutationFn: () =>
      api(`/jobs/${id}/price-challenges`, {
        body: {
          quoteItemId: lineId,
          sellerId: unlisted ? undefined : seller?.id,
          unlistedSellerName: unlisted ? search.trim() : undefined,
          evidenceUrl,
          claimedUnitCostMinor: toMinor(price),
          fastTrack,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      router.back();
    },
    onError: (e: ApiError) => Alert.alert('Challenge not sent', e.message),
  });

  const pickEvidence = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (r.canceled) return;
    const a = r.assets[0];
    setEvidenceUrl(await uploadFile('evidence', { uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 1_000_000 }));
  };

  return (
    <Screen>
      {line ? (
        <Card>
          <T v="heading">{line.description}</T>
          <T muted>Quoted base cost: {formatMoney(line.baseUnitCostMinor)} each</T>
        </Card>
      ) : null}

      <T v="heading">Where did you find it cheaper?</T>
      <TextInput value={search} onChangeText={(v) => { setSearch(v); setSeller(null); }} placeholder="Search registered sellers" placeholderTextColor={t.color.textMuted} style={input} />
      {!unlisted
        ? (sellers.data ?? []).map((s) => (
            <Pressable key={s.id} onPress={() => setSeller(s)}>
              <Card style={{ borderWidth: 2, borderColor: seller?.id === s.id ? t.color.primary : 'transparent' }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T>{s.name}</T>
                  <Tag label={s.verification_status === 'verified' ? 'Verified' : 'Provisional'} tone={s.verification_status === 'verified' ? 'success' : 'neutral'} />
                </Row>
                {s.address ? <T v="small" muted>{s.address}</T> : null}
              </Card>
            </Pressable>
          ))
        : null}
      <Row style={{ justifyContent: 'space-between' }}>
        <T style={{ flex: 1 }}>The seller isn't listed</T>
        <Switch value={unlisted} onValueChange={(v) => { setUnlisted(v); setSeller(null); }} />
      </Row>
      {unlisted ? <Banner tone="info" text="Type the seller's name above. A Handiwork-Deck admin will check your evidence before the technician is asked to respond." /> : null}

      <T v="small" muted>Their price per item (₦)</T>
      <TextInput value={price} onChangeText={setPrice} keyboardType="numeric" style={input} />
      <Button title={evidenceUrl ? 'Invoice / price proof attached ✓' : 'Attach invoice or price proof'} kind="secondary" onPress={pickEvidence} />
      <Row style={{ justifyContent: 'space-between' }}>
        <T style={{ flex: 1 }}>Urgent — Fast Track (24-hour resolution)</T>
        <Switch value={fastTrack} onValueChange={setFastTrack} />
      </Row>
      <Button
        title="Send challenge"
        loading={submit.isPending}
        disabled={!evidenceUrl || !price || (!seller && !(unlisted && search.trim().length >= 2))}
        onPress={() => submit.mutate()}
      />
    </Screen>
  );
}
