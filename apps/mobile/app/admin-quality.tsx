import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { Badge, Button, Card, colors, ErrorText, Field, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface Seller {
  id: string;
  name: string;
  city: string | null;
  registration_number: string | null;
  is_verified: boolean;
}
interface Flag {
  id: string;
  technician_name: string;
  kind: string;
  details: Record<string, unknown>;
  created_at: string;
}
interface Adjustment {
  id: string;
  technician_name: string;
  rating_used: number | null;
  rating_without_latest: number | null;
  previous_stars: number | null;
  new_stars: number | null;
  previous_bps: number;
  new_bps: number;
  status: string;
  created_at: string;
}

const pct = (bps: number) => `${bps > 0 ? '+' : ''}${bps / 100}%`;

/** Seller registry (Section 10 placeholder), technician flags, and labor-rate swings held for review (Section 7a). */
export default function AdminQuality() {
  const sellers = useApi<{ sellers: Seller[] }>('/admin/sellers');
  const flags = useApi<{ flags: Flag[] }>('/admin/flags');
  const held = useApi<{ adjustments: Adjustment[] }>('/admin/rate-adjustments?status=held');
  const applied = useApi<{ adjustments: Adjustment[] }>('/admin/rate-adjustments?status=applied');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [reg, setReg] = useState('');
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([sellers.reload(), flags.reload(), held.reload(), applied.reload()]);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Screen>
      <ErrorText error={error} />
      <Card>
        <Text style={styles.label}>Labor rate changes held for review</Text>
        {held.data?.adjustments.length === 0 && <Muted>None.</Muted>}
        {held.data?.adjustments.map((a) => (
          <View key={a.id} style={{ gap: 4, borderTopWidth: 1, borderColor: colors.line, paddingTop: 6 }}>
            <Text style={{ fontWeight: '600' }}>{a.technician_name}</Text>
            <Muted>
              {a.previous_stars ?? '—'}★ ({pct(a.previous_bps)}) → {a.new_stars ?? '—'}★ ({pct(a.new_bps)}) · rating {a.rating_used} ({a.rating_without_latest} without the latest review)
            </Muted>
            <View style={styles.row}>
              <Button title="Apply new tier" onPress={() => run(() => api(`/admin/rate-adjustments/${a.id}/decide`, { body: { decision: 'approve' } }))} />
              <Button title="Keep previous tier" variant="secondary" onPress={() => run(() => api(`/admin/rate-adjustments/${a.id}/decide`, { body: { decision: 'reject' } }))} />
            </View>
          </View>
        ))}
      </Card>

      <Card>
        <Text style={styles.label}>Recent labor rate changes</Text>
        {applied.data?.adjustments.slice(0, 20).map((a) => (
          <View key={a.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <Muted>
              {a.technician_name}: {a.previous_stars ?? '—'}★ → {a.new_stars ?? '—'}★ ({pct(a.new_bps)})
            </Muted>
            {a.new_stars != null && a.previous_stars != null && a.new_stars < a.previous_stars && (
              <Button title="Flag swing" variant="secondary" onPress={() => run(() => api(`/admin/rate-adjustments/${a.id}/flag`, { body: {} }))} />
            )}
          </View>
        ))}
      </Card>

      <Card>
        <Text style={styles.label}>Open technician flags</Text>
        {flags.data?.flags.length === 0 && <Muted>None.</Muted>}
        {flags.data?.flags.map((f) => (
          <View key={f.id} style={{ gap: 4, borderTopWidth: 1, borderColor: colors.line, paddingTop: 6 }}>
            <View style={styles.row}>
              <Text style={{ fontWeight: '600' }}>{f.technician_name}</Text>
              <Badge label={f.kind.replace(/_/g, ' ')} tone="warn" />
            </View>
            <Muted>{JSON.stringify(f.details)}</Muted>
            <Button title="Mark resolved" variant="secondary" onPress={() => run(() => api(`/admin/flags/${f.id}/resolve`, { body: {} }))} />
          </View>
        ))}
      </Card>

      <Card>
        <Text style={styles.label}>Verified spare-parts sellers</Text>
        <Muted>Customers can only challenge part prices with evidence from verified sellers.</Muted>
        {sellers.data?.sellers.map((s) => (
          <View key={s.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ flex: 1 }}>
              {s.name}
              {s.city ? <Text style={{ color: colors.muted }}> · {s.city}</Text> : null}
            </Text>
            <Switch value={s.is_verified} onValueChange={(v) => run(() => api(`/admin/sellers/${s.id}`, { method: 'PATCH', body: { isVerified: v } }))} />
          </View>
        ))}
        <Field label="Seller name" value={name} onChangeText={setName} />
        <Field label="City" value={city} onChangeText={setCity} />
        <Field label="Registration number" value={reg} onChangeText={setReg} />
        <Button
          title="Add verified seller"
          disabled={name.trim().length < 2}
          onPress={() =>
            run(async () => {
              await api('/admin/sellers', { body: { name: name.trim(), city: city.trim() || undefined, registrationNumber: reg.trim() || undefined, isVerified: true } });
              setName('');
              setCity('');
              setReg('');
            })
          }
        />
      </Card>
    </Screen>
  );
}
