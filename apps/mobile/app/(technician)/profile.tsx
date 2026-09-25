import { SERVICE_SEGMENTS } from '@handiwork/shared';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { ProfileScreen } from '@/components/ProfileScreen';
import { Badge, Button, Card, Chip, ErrorText, Field, Muted, styles } from '@/components/ui';
import { api, uploadFile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { type Category, SEGMENT_LABEL } from '@/lib/categories';
import { useApi } from '@/lib/useApi';

interface TechProfile {
  verification_status: string;
  is_available: boolean;
  services: { id: number }[];
}

export default function TechnicianProfile() {
  const { user } = useAuth();
  const { data: cats } = useApi<{ categories: Category[] }>('/categories');
  const { data: me, reload } = useApi<{ technician: TechProfile }>(user ? `/technicians/${user.id}` : null);
  const [selected, setSelected] = useState<number[]>([]);
  const [radius, setRadius] = useState('15');
  const [bio, setBio] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [currency, setCurrency] = useState('NGN');

  useEffect(() => {
    if (me) setSelected(me.technician.services.map((s) => s.id));
  }, [me]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setError(null);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const saveBase = () =>
    run('base', async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw new Error('Location permission denied');
      const pos = await Location.getCurrentPositionAsync({});
      await api('/technicians/me', {
        method: 'PUT',
        body: { baseLat: pos.coords.latitude, baseLng: pos.coords.longitude, serviceRadiusKm: Number(radius) || 15, bio: bio.trim() || undefined },
      });
      return 'Base location saved';
    });

  const saveServices = () =>
    run('services', async () => {
      await api('/technicians/me/services', { method: 'PUT', body: { services: selected.map((categoryId) => ({ categoryId })) } });
      return 'Services saved';
    });

  const setupPayouts = () =>
    run('payout', async () => {
      const res = await api<{ onboardingUrl: string | null; provider: string }>('/technicians/me/payout-account', {
        body: {
          currency,
          country: { NGN: 'NG', GHS: 'GH', KES: 'KE', USD: 'US' }[currency] ?? 'NG',
          bank: bankCode && accountNumber ? { bankCode, accountNumber } : undefined,
        },
      });
      if (res.onboardingUrl) await WebBrowser.openBrowserAsync(res.onboardingUrl);
      return `Payouts set up with ${res.provider}`;
    });

  const addPortfolio = () =>
    run('portfolio', async () => {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const asset = r.assets?.[0];
      if (r.canceled || !asset) return;
      const fileId = await uploadFile(asset.uri, 'portfolio', asset.mimeType ?? 'image/jpeg');
      await api('/technicians/me/portfolio', { body: { fileId } });
      return 'Added to portfolio';
    });

  const status = me?.technician.verification_status;
  return (
    <ProfileScreen>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.label}>Verification</Text>
          {status && <Badge label={status} tone={status === 'verified' ? 'good' : status === 'pending' ? 'warn' : 'bad'} />}
        </View>
        {status === 'pending' && <Muted>Upload an ID document and complete your profile; our team will verify you.</Muted>}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text>Available for new jobs</Text>
          <Switch
            value={me?.technician.is_available ?? true}
            onValueChange={(v) => run('avail', async () => void (await api('/technicians/me', { method: 'PUT', body: { isAvailable: v } })))}
          />
        </View>
      </Card>

      <Card>
        <Text style={styles.label}>Base location & reach</Text>
        <Field label="Service radius (km)" value={radius} onChangeText={setRadius} keyboardType="number-pad" />
        <Field label="Short bio" value={bio} onChangeText={setBio} multiline />
        <Button title="Save using my current location" loading={busy === 'base'} onPress={saveBase} />
      </Card>

      <Card>
        <Text style={styles.label}>Services I offer</Text>
        {SERVICE_SEGMENTS.map((seg) => (
          <View key={seg} style={{ gap: 6 }}>
            <Muted>{SEGMENT_LABEL[seg]}</Muted>
            <View style={styles.row}>
              {cats?.categories
                .filter((c) => c.segment === seg)
                .map((c) => (
                  <Chip
                    key={c.id}
                    label={c.name}
                    selected={selected.includes(c.id)}
                    onPress={() => setSelected((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                  />
                ))}
            </View>
          </View>
        ))}
        <Button title="Save services" loading={busy === 'services'} disabled={!selected.length} onPress={saveServices} />
      </Card>

      <Card>
        <Text style={styles.label}>Payouts</Text>
        <View style={styles.row}>
          {['NGN', 'GHS', 'KES', 'USD'].map((c) => (
            <Chip key={c} label={c} selected={currency === c} onPress={() => setCurrency(c)} />
          ))}
        </View>
        {currency !== 'USD' && (
          <>
            <Field label="Bank code" value={bankCode} onChangeText={setBankCode} />
            <Field label="Account number" value={accountNumber} onChangeText={setAccountNumber} keyboardType="number-pad" />
          </>
        )}
        <Button title="Set up payouts" loading={busy === 'payout'} onPress={setupPayouts} />
      </Card>

      <View style={styles.row}>
        <Button title="Add portfolio photo" variant="secondary" loading={busy === 'portfolio'} onPress={addPortfolio} />
        <Button
          title="Upload ID document"
          variant="secondary"
          onPress={() =>
            run('id', async () => {
              const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
              const asset = r.assets?.[0];
              if (r.canceled || !asset) return;
              await uploadFile(asset.uri, 'id_document', asset.mimeType ?? 'image/jpeg');
              return 'ID document uploaded for review';
            })
          }
        />
      </View>
      {msg ? <Muted>{msg}</Muted> : null}
      <ErrorText error={error} />
    </ProfileScreen>
  );
}
