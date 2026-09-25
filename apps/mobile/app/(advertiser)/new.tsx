import { toMinor } from '@handiwork/shared';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, ErrorText, Field, Muted, Screen, styles } from '@/components/ui';
import { api, uploadFile } from '@/lib/api';
import type { Category } from '@/lib/categories';
import { useApi } from '@/lib/useApi';

export default function NewCampaign() {
  const { data: cats } = useApi<{ categories: Category[] }>('/categories');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [clickUrl, setClickUrl] = useState('');
  const [budget, setBudget] = useState('');
  const [currency] = useState('NGN');
  const [targets, setTargets] = useState<number[]>([]);
  const [creative, setCreative] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pickCreative = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const asset = r.assets?.[0];
    if (r.canceled || !asset) return;
    try {
      setCreative(await uploadFile(asset.uri, 'ad_creative', asset.mimeType ?? 'image/jpeg'));
    } catch (e) {
      setError(e);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/ads', {
        body: {
          title: title.trim(),
          body: body.trim() || undefined,
          clickUrl: clickUrl.trim() || undefined,
          creativeFileId: creative ?? undefined,
          targetCategoryIds: targets,
          budgetMinor: budget ? toMinor(Number(budget), currency) : 0,
          currency,
        },
      });
      router.replace('/(advertiser)');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Field label="Headline" value={title} onChangeText={setTitle} maxLength={80} />
      <Field label="Body" value={body} onChangeText={setBody} maxLength={280} multiline />
      <Field label="Link (shop / WhatsApp catalogue)" value={clickUrl} onChangeText={setClickUrl} autoCapitalize="none" />
      <Field label={`Budget (${currency}, optional)`} value={budget} onChangeText={setBudget} keyboardType="decimal-pad" />
      <Button title={creative ? 'Image attached ✓' : 'Attach image'} variant="secondary" onPress={pickCreative} />
      <Muted>Show to people booking (leave empty for all services):</Muted>
      <View style={styles.row}>
        {cats?.categories.map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            selected={targets.includes(c.id)}
            onPress={() => setTargets((t) => (t.includes(c.id) ? t.filter((x) => x !== c.id) : [...t, c.id]))}
          />
        ))}
      </View>
      <Button title="Save draft" loading={busy} disabled={title.trim().length < 3} onPress={submit} />
      <ErrorText error={error} />
    </Screen>
  );
}
