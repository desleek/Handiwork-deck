import Ionicons from '@expo/vector-icons/Ionicons';
import { LABOR_STANCE_LABEL, LABOR_STANCES, type LaborStance, SERVICE_SEGMENTS, type ServiceSegment, toMajor, toMinor } from '@handiwork/shared';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Image, Pressable, Switch, Text, View } from 'react-native';
import { ProfileScreen } from '@/components/ProfileScreen';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Muted, styles } from '@/components/ui';
import { api, uploadFile } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { type Category, SEGMENT_LABEL } from '@/lib/categories';
import { useApi } from '@/lib/useApi';

const MAX_PORTFOLIO = 5;

interface TechProfile {
  verification_status: string;
  is_available: boolean;
  headline: string | null;
  labor_stance: LaborStance;
  instant_book_enabled: boolean;
  services: { id: number; base_rate_minor: number | null; currency: string | null }[];
  portfolio: { id: string; url: string | null }[];
  certifications: { title: string; issuer: string | null; is_verified: boolean }[];
}

export default function TechnicianProfile() {
  const { user } = useAuth();
  const { data: cats } = useApi<{ categories: Category[] }>('/categories');
  const { data: me, reload } = useApi<{ technician: TechProfile }>(user ? `/technicians/${user.id}` : null);
  const [rates, setRates] = useState<Record<number, string>>({}); // selected category -> starting price (major units)
  const [currency, setCurrency] = useState('NGN');
  const [segment, setSegment] = useState<ServiceSegment>('household_office');
  const [radius, setRadius] = useState('15');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [certTitle, setCertTitle] = useState('');
  const [certIssuer, setCertIssuer] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const t = me?.technician;
  useEffect(() => {
    if (!t) return;
    setRates(Object.fromEntries(t.services.map((s) => [s.id, s.base_rate_minor != null ? String(toMajor(s.base_rate_minor, s.currency ?? 'NGN')) : ''])));
    if (t.services[0]?.currency) setCurrency(t.services[0].currency);
    setHeadline(t.headline ?? '');
  }, [t]);

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
  const put = (body: object) => api('/technicians/me', { method: 'PUT', body });
  const pickImage = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    return r.canceled ? null : (r.assets?.[0] ?? null);
  };

  const saveBase = () =>
    run('base', async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw new Error('Location permission denied');
      const pos = await Location.getCurrentPositionAsync({});
      await put({ baseLat: pos.coords.latitude, baseLng: pos.coords.longitude, serviceRadiusKm: Number(radius) || 15, bio: bio.trim() || undefined, headline: headline.trim() || undefined });
      return 'Profile and base location saved';
    });

  const saveServices = () =>
    run('services', async () => {
      const services = Object.entries(rates).map(([categoryId, rate]) => ({
        categoryId: Number(categoryId),
        baseRateMinor: rate ? toMinor(Number(rate), currency) : undefined,
        currency: rate ? currency : undefined,
      }));
      await api('/technicians/me/services', { method: 'PUT', body: { services } });
      return 'Services and starting prices saved';
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

  const status = t?.verification_status;
  const portfolioFull = (t?.portfolio.length ?? 0) >= MAX_PORTFOLIO;

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
          <Switch value={t?.is_available ?? true} onValueChange={(v) => run('avail', async () => void (await put({ isAvailable: v })))} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text>Allow instant booking</Text>
            <Muted>Customers can book you immediately at your starting price.</Muted>
          </View>
          <Switch value={t?.instant_book_enabled ?? false} onValueChange={(v) => run('instant', async () => void (await put({ instantBookEnabled: v })))} />
        </View>
        <Button title="Wallet & earnings" variant="secondary" onPress={() => router.push('/wallet')} />
      </Card>

      <Card>
        <Text style={styles.label}>Labor-only jobs</Text>
        <Muted>Can customers supply the materials and pay you for labor only?</Muted>
        {LABOR_STANCES.map((s) => (
          <Chip key={s} label={LABOR_STANCE_LABEL[s]} selected={t?.labor_stance === s} onPress={() => run('stance', async () => void (await put({ laborStance: s })))} />
        ))}
      </Card>

      <Card>
        <Text style={styles.label}>About you</Text>
        <Field label="Headline" value={headline} onChangeText={setHeadline} placeholder="e.g. Certified plumber, 10 yrs, Ikeja" maxLength={120} />
        <Field label="Short bio" value={bio} onChangeText={setBio} multiline />
        <Field label="Service radius (km)" value={radius} onChangeText={setRadius} keyboardType="number-pad" />
        <Button title="Save (uses my current location as base)" loading={busy === 'base'} onPress={saveBase} />
        <Button
          title="Change profile photo"
          variant="secondary"
          loading={busy === 'avatar'}
          onPress={() =>
            run('avatar', async () => {
              const a = await pickImage();
              if (!a) return;
              const fileId = await uploadFile(a.uri, 'avatar', a.mimeType ?? 'image/jpeg');
              await put({ avatarFileId: fileId });
              return 'Photo updated';
            })
          }
        />
      </Card>

      <Card>
        <Text style={styles.label}>Services & starting prices</Text>
        <View style={styles.row}>
          {SERVICE_SEGMENTS.map((s) => (
            <Chip key={s} label={SEGMENT_LABEL[s]} selected={segment === s} onPress={() => setSegment(s)} />
          ))}
        </View>
        <View style={styles.row}>
          {cats?.categories
            .filter((c) => c.segment === segment && !c.is_other)
            .map((c) => (
              <Chip
                key={c.id}
                label={c.name}
                selected={c.id in rates}
                onPress={() =>
                  setRates((r) => {
                    const next = { ...r };
                    if (c.id in next) delete next[c.id];
                    else next[c.id] = '';
                    return next;
                  })
                }
              />
            ))}
        </View>
        <View style={styles.row}>
          {['NGN', 'GHS', 'KES', 'USD'].map((c) => (
            <Chip key={c} label={c} selected={currency === c} onPress={() => setCurrency(c)} />
          ))}
        </View>
        {Object.keys(rates).map((cid) => {
          const cat = cats?.categories.find((c) => c.id === Number(cid));
          return (
            <Field
              key={cid}
              label={`${cat?.name ?? 'Service'} — starting price (${currency})`}
              value={rates[Number(cid)]}
              onChangeText={(v) => setRates((r) => ({ ...r, [Number(cid)]: v }))}
              keyboardType="decimal-pad"
              placeholder="Optional"
            />
          );
        })}
        <Button title="Save services" loading={busy === 'services'} disabled={!Object.keys(rates).length} onPress={saveServices} />
        <Muted>Trade not listed?</Muted>
        <Field label="Suggest a trade" value={suggestion} onChangeText={setSuggestion} placeholder="e.g. Swimming pool maintenance" />
        <Button
          title="Send suggestion"
          variant="secondary"
          disabled={suggestion.trim().length < 3}
          onPress={() =>
            run('suggest', async () => {
              await api('/categories/suggestions', { body: { name: suggestion.trim(), segment } });
              setSuggestion('');
              return "Thanks — we'll add it to your profile once approved.";
            })
          }
        />
      </Card>

      <Card>
        <Text style={styles.label}>
          Portfolio ({t?.portfolio.length ?? 0}/{MAX_PORTFOLIO})
        </Text>
        <View style={styles.row}>
          {t?.portfolio.map((p) => (
            <View key={p.id}>
              {p.url ? <Image source={{ uri: p.url }} style={{ width: 96, height: 96, borderRadius: 8, backgroundColor: colors.line }} /> : null}
              <Pressable
                onPress={() => run('del', async () => void (await api(`/technicians/me/portfolio/${p.id}`, { method: 'DELETE' })))}
                style={{ position: 'absolute', top: 4, right: 4, backgroundColor: '#fff', borderRadius: 999 }}
                accessibilityLabel="Remove image"
              >
                <Ionicons name="close-circle" size={22} color={colors.danger} />
              </Pressable>
            </View>
          ))}
        </View>
        <Button
          title={portfolioFull ? 'Portfolio full — remove one to add another' : 'Add portfolio photo'}
          variant="secondary"
          disabled={portfolioFull}
          loading={busy === 'portfolio'}
          onPress={() =>
            run('portfolio', async () => {
              const a = await pickImage();
              if (!a) return;
              const fileId = await uploadFile(a.uri, 'portfolio', a.mimeType ?? 'image/jpeg');
              await api('/technicians/me/portfolio', { body: { fileId } });
              return 'Added to portfolio';
            })
          }
        />
      </Card>

      <Card>
        <Text style={styles.label}>Certifications</Text>
        {t?.certifications.map((c, i) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text>
              {c.title}
              {c.issuer ? ` · ${c.issuer}` : ''}
            </Text>
            <Badge label={c.is_verified ? 'Verified' : 'Pending'} tone={c.is_verified ? 'good' : 'warn'} />
          </View>
        ))}
        <Field label="Certificate" value={certTitle} onChangeText={setCertTitle} placeholder="e.g. COREN registered" />
        <Field label="Issuer" value={certIssuer} onChangeText={setCertIssuer} />
        <Button
          title="Add certificate (attach photo)"
          variant="secondary"
          disabled={certTitle.trim().length < 2}
          onPress={() =>
            run('cert', async () => {
              const a = await pickImage();
              const fileId = a ? await uploadFile(a.uri, 'id_document', a.mimeType ?? 'image/jpeg') : undefined;
              await api('/technicians/me/certifications', { body: { title: certTitle.trim(), issuer: certIssuer.trim() || undefined, fileId } });
              setCertTitle('');
              setCertIssuer('');
              return 'Certificate submitted for verification';
            })
          }
        />
        <Button
          title="Upload ID document"
          variant="secondary"
          onPress={() =>
            run('id', async () => {
              const a = await pickImage();
              if (!a) return;
              await uploadFile(a.uri, 'id_document', a.mimeType ?? 'image/jpeg');
              return 'ID document uploaded for review';
            })
          }
        />
      </Card>

      <Card>
        <Text style={styles.label}>Payouts ({currency})</Text>
        {currency !== 'USD' && (
          <>
            <Field label="Bank code" value={bankCode} onChangeText={setBankCode} />
            <Field label="Account number" value={accountNumber} onChangeText={setAccountNumber} keyboardType="number-pad" />
          </>
        )}
        <Button title="Set up payouts" loading={busy === 'payout'} onPress={setupPayouts} />
        <Muted>Without payouts set up, customer payments are credited to your wallet instead.</Muted>
      </Card>

      {msg ? <Muted>{msg}</Muted> : null}
      <ErrorText error={error} />
    </ProfileScreen>
  );
}
