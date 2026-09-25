import { toMinor } from '@handiwork/shared';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Button, Chip, ErrorText, Field, Muted, Screen, styles, Title } from '@/components/ui';
import { api, uploadFile } from '@/lib/api';
import { View } from 'react-native';

const CURRENCIES = ['NGN', 'GHS', 'KES', 'USD'];

export default function PostJob() {
  const { categoryId, name } = useLocalSearchParams<{ categoryId: string; name: string }>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('NGN');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [boqFileId, setBoqFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const useMyLocation = async () => {
    setError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw new Error('Location permission denied');
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      if (!address) {
        const [place] = await Location.reverseGeocodeAsync(pos.coords);
        if (place) setAddress([place.name, place.street, place.city].filter(Boolean).join(', '));
      }
    } catch (e) {
      setError(e);
    }
  };

  const pick = async (kind: 'job_photo' | 'boq') => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    const asset = res.assets?.[0];
    if (res.canceled || !asset) return;
    try {
      const id = await uploadFile(asset.uri, kind, asset.mimeType ?? 'image/jpeg');
      if (kind === 'boq') setBoqFileId(id);
      else setPhotos((p) => [...p, id]);
    } catch (e) {
      setError(e);
    }
  };

  const submit = async () => {
    if (!coords) return setError(new Error('Set the job location first'));
    setBusy(true);
    setError(null);
    try {
      const { job } = await api<{ job: { id: string } }>('/jobs', {
        body: {
          categoryId: Number(categoryId),
          title: title.trim(),
          description: description.trim() || undefined,
          address: address.trim(),
          ...coords,
          currency,
          budgetMinor: budget ? toMinor(Number(budget), currency) : undefined,
          photoFileIds: photos,
          boqFileId: boqFileId ?? undefined,
        },
      });
      router.replace(`/job/${job.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>{name}</Title>
      <Field label="What needs doing?" value={title} onChangeText={setTitle} placeholder="e.g. Leaking kitchen sink" />
      <Field label="Details" value={description} onChangeText={setDescription} multiline />
      <Field label="Address" value={address} onChangeText={setAddress} />
      <Button title={coords ? 'Location set ✓' : 'Use my current location'} variant="secondary" onPress={useMyLocation} />
      <Field label="Budget (optional)" value={budget} onChangeText={setBudget} keyboardType="decimal-pad" />
      <View style={styles.row}>
        {CURRENCIES.map((c) => (
          <Chip key={c} label={c} selected={currency === c} onPress={() => setCurrency(c)} />
        ))}
      </View>
      <View style={styles.row}>
        <Chip label={`Add photo${photos.length ? ` (${photos.length})` : ''}`} onPress={() => pick('job_photo')} />
        <Chip label={boqFileId ? 'BOQ attached ✓' : 'Attach BOQ'} onPress={() => pick('boq')} />
      </View>
      <Muted>Nearby verified technicians are notified immediately. If nobody quotes quickly we widen the search and our team steps in.</Muted>
      <Button title="Post job" loading={busy} disabled={title.trim().length < 3 || address.trim().length < 3} onPress={submit} />
      <ErrorText error={error} />
    </Screen>
  );
}
