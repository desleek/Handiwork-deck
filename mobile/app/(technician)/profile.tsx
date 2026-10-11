import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { api, ApiError, uploadFile } from '../../src/api/client';
import type { Category } from '../../src/api/types';
import { Banner, Button, Card, Divider, Row, Screen, T, Tag, useChoiceSheet } from '../../src/components/ui';
import { currentPosition, ensureForegroundLocation } from '../../src/lib/location';
import { formatMoney, toMinor } from '../../src/lib/money';
import { queryClient } from '../../src/lib/offline';
import { useTheme } from '../../src/theme';

/**
 * Technician onboarding & profile (Section 4): ID, services with the mandatory per-category
 * labor-only declaration, coverage area, portfolio (max 5), certifications.
 */
export default function TechnicianProfileEditor() {
  const t = useTheme();
  const sheet = useChoiceSheet();
  const { data } = useQuery({ queryKey: ['tech-profile'], queryFn: () => api('/technician/profile') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ household_office: Category[]; construction: Category[] }>('/categories') });
  const [bio, setBio] = useState<string | null>(null);
  const [radius, setRadius] = useState('10');
  const [newCat, setNewCat] = useState<Category | null>(null);
  const [price, setPrice] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tech-profile'] });
  const input = { backgroundColor: t.color.bg, borderRadius: t.radius.sm, padding: t.space(3), color: t.color.text, borderWidth: 1, borderColor: t.color.border };
  const onErr = (e: ApiError) => Alert.alert('Not saved', e.message);

  const save = useMutation({ mutationFn: (body: object) => api('/technician/profile', { method: 'PUT', body }), onSuccess: refresh, onError: onErr });

  const pickAndUpload = async (kind: 'portfolio' | 'id_document' | 'certification') => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (r.canceled) return null;
    const a = r.assets[0];
    return uploadFile(kind, { uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg', size: a.fileSize ?? 2_000_000, name: a.fileName ?? 'image.jpg' });
  };

  const addService = async () => {
    if (!newCat) return;
    // The labor-only declaration is mandatory and explicit (Section 4).
    const i = await sheet.open(`Labor-only jobs for ${newCat.name}?`, [
      'Accept — customers may supply their own parts',
      'Decline from inception — I always supply parts',
    ]);
    if (i === null) return;
    try {
      await api('/technician/categories', { body: { categoryId: newCat.id, startingPriceMinor: toMinor(price), laborOnlyStance: i === 0 ? 'accept' : 'decline_from_inception' } });
      setNewCat(null);
      setPrice('');
      refresh();
    } catch (e: any) {
      onErr(e);
    }
  };

  const switchStance = async (c: any) => {
    const next = c.labor_only_stance === 'accept' ? 'decline_from_inception' : 'accept';
    Alert.alert(
      'Change labor-only setting?',
      `You can change this again after a 30-day cooldown. Past rejections still count. New setting: ${next === 'accept' ? 'Accept labor-only' : 'Decline from inception'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Change', onPress: () => api(`/technician/categories/${c.category_id}`, { method: 'PATCH', body: { laborOnlyStance: next } }).then(refresh).catch(onErr) },
      ],
    );
  };

  if (!data) return null;
  const p = data.profile;
  const all = [...(categories.data?.household_office ?? []), ...(categories.data?.construction ?? [])].filter((c) => !data.categories.some((x: any) => x.category_id === c.id));

  return (
    <Screen>
      {sheet.element}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">Verification</T>
          <Tag label={p.verification_status} tone={p.verification_status === 'verified' ? 'success' : p.verification_status === 'rejected' ? 'danger' : 'warning'} />
        </Row>
        <Button
          title={p.id_document_url ? 'ID uploaded ✓ (replace)' : 'Upload government ID'}
          kind="secondary"
          onPress={async () => {
            const url = await pickAndUpload('id_document');
            if (url) save.mutate({ idDocumentUrl: url });
          }}
        />
      </Card>

      <Card>
        <T v="heading">About you</T>
        <TextInput value={bio ?? p.bio ?? ''} onChangeText={setBio} multiline placeholder="Experience, specialties, tools you bring…" placeholderTextColor={t.color.textMuted} style={[input, { minHeight: 80 }]} />
        <Row>
          <T>Coverage radius (km)</T>
          <TextInput value={radius} onChangeText={setRadius} keyboardType="numeric" style={[input, { width: 70 }]} />
        </Row>
        <Button
          title="Save & set coverage centre to here"
          loading={save.isPending}
          onPress={async () => {
            const ok = await ensureForegroundLocation('Your coverage area is centred where you usually work.');
            const pos = ok ? await currentPosition() : null;
            save.mutate({ bio: bio ?? undefined, ...(pos ? { coverage: { ...pos, radiusKm: Number(radius) || 10 } } : {}) });
          }}
        />
      </Card>

      <Card>
        <T v="heading">Services</T>
        {data.categories.map((c: any) => (
          <View key={c.category_id} style={{ gap: 4 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row gap={2} style={{ flex: 1 }}>
                <MaterialCommunityIcons name={c.icon} size={20} color={t.color.primary} />
                <T style={{ flex: 1 }}>{c.name}</T>
              </Row>
              <T>{formatMoney(c.starting_price_minor)}</T>
            </Row>
            <Pressable onPress={() => switchStance(c)}>
              <T v="small" style={{ color: t.color.link }}>
                {c.labor_only_stance === 'accept' ? 'Accepts labor-only' : 'Declines labor-only (from inception)'} · change
              </T>
            </Pressable>
            <Divider />
          </View>
        ))}
        <T v="small" muted>Add a service</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space(2) }}>
          {all.map((c) => (
            <Pressable key={c.id} onPress={() => setNewCat(c)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 100, backgroundColor: newCat?.id === c.id ? t.color.primary : t.color.surfaceAlt }}>
              <T v="small" style={{ color: newCat?.id === c.id ? t.color.primaryText : t.color.text }}>{c.name}</T>
            </Pressable>
          ))}
        </ScrollView>
        {newCat ? (
          <>
            <TextInput value={price} onChangeText={setPrice} keyboardType="numeric" placeholder={`Standard labor rate for ${newCat.name} (₦)`} placeholderTextColor={t.color.textMuted} style={input} />
            <Button title="Add service" disabled={!price} onPress={addService} />
          </>
        ) : null}
      </Card>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T v="heading">Portfolio</T>
          <T v="small" muted>{data.portfolio.length}/5</T>
        </Row>
        <ScrollView horizontal contentContainerStyle={{ gap: t.space(2) }}>
          {data.portfolio.map((img: any) => (
            <Pressable
              key={img.id}
              onLongPress={() => Alert.alert('Remove photo?', '', [{ text: 'Cancel' }, { text: 'Remove', style: 'destructive', onPress: () => api(`/technician/portfolio/${img.id}`, { method: 'DELETE' }).then(refresh) }])}
            >
              <Image source={{ uri: img.url }} style={{ width: 110, height: 110, borderRadius: t.radius.sm, opacity: img.moderation_status === 'approved' ? 1 : 0.5 }} />
              {img.moderation_status !== 'approved' ? <T v="tiny" muted>In review</T> : null}
            </Pressable>
          ))}
        </ScrollView>
        {data.portfolio.length < 5 ? (
          <Button
            title="Add photo"
            kind="secondary"
            onPress={async () => {
              const url = await pickAndUpload('portfolio');
              if (url) api('/technician/portfolio', { body: { url } }).then(refresh).catch(onErr);
            }}
          />
        ) : (
          <Banner tone="info" text="You've reached the 5-photo limit. Long-press a photo to remove it." />
        )}
      </Card>

      <Card>
        <T v="heading">Certifications</T>
        {data.certifications.map((c: any) => (
          <Row key={c.id} style={{ justifyContent: 'space-between' }}>
            <T>{c.title}</T>
            <Tag label={c.status} tone={c.status === 'verified' ? 'success' : 'neutral'} />
          </Row>
        ))}
        <Button
          title="Add certification"
          kind="secondary"
          onPress={async () => {
            const url = await pickAndUpload('certification');
            if (!url) return;
            const create = (title: string) => api('/technician/certifications', { body: { title, fileUrl: url } }).then(refresh).catch(onErr);
            // Alert.prompt is iOS-only; Android uses a default title the admin can see alongside the file.
            if (Platform.OS === 'ios') Alert.prompt('Certification title', 'e.g. COREN registered welder', (title) => create(title || 'Trade certificate'));
            else create('Trade certificate');
          }}
        />
      </Card>
    </Screen>
  );
}
