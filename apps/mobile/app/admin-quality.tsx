import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

type SellerStatus = 'unlisted' | 'provisional' | 'verified' | 'flagged' | 'removed' | 'merged';
interface Seller {
  id: string;
  name: string;
  city: string | null;
  phone: string | null;
  registration_number: string | null;
  status: SellerStatus;
  clean_approvals: number;
  evidence_count: number;
  created_via: 'admin' | 'evidence';
  flag_reason: string | null;
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

/** Seller registry (Section 10), technician flags, and labor-rate swings held for review (Section 7a). */
export default function AdminQuality() {
  const flags = useApi<{ flags: Flag[] }>('/admin/flags');
  const held = useApi<{ adjustments: Adjustment[] }>('/admin/rate-adjustments?status=held');
  const applied = useApi<{ adjustments: Adjustment[] }>('/admin/rate-adjustments?status=applied');
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([flags.reload(), held.reload(), applied.reload()]);
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

      <SellerRegistry onError={setError} />
    </Screen>
  );
}

const STATUS_TONE: Record<SellerStatus, 'good' | 'warn' | 'bad' | 'neutral'> = {
  verified: 'good',
  provisional: 'warn',
  unlisted: 'neutral',
  flagged: 'bad',
  removed: 'bad',
  merged: 'neutral',
};

/**
 * Section 10 graduated trust: seed verified sellers, upgrade provisional ones,
 * flag/remove fraud, merge duplicates, and configure auto-verification.
 */
function SellerRegistry({ onError }: { onError: (e: unknown) => void }) {
  const [filter, setFilter] = useState<SellerStatus | 'all'>('all');
  const sellers = useApi<{ sellers: Seller[] }>(`/admin/sellers${filter === 'all' ? '' : `?status=${filter}`}`);
  const settings = useApi<{ settings: { seller_registry: { autoVerifyEnabled: boolean; cleanApprovalsRequired: number } } }>('/admin/settings');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [phone, setPhone] = useState('');
  const [reg, setReg] = useState('');
  const [reason, setReason] = useState('');
  const [mergeFrom, setMergeFrom] = useState<Seller | null>(null);
  const [autoN, setAutoN] = useState('');
  const cfg = settings.data?.settings.seller_registry;

  const run = async (fn: () => Promise<unknown>) => {
    onError(null);
    try {
      await fn();
      await Promise.all([sellers.reload(), settings.reload()]);
    } catch (e) {
      onError(e);
    }
  };
  const setStatus = (s: Seller, status: SellerStatus) => run(() => api(`/admin/sellers/${s.id}/status`, { body: { status, reason: reason.trim() || undefined } }));

  return (
    <Card>
      <Text style={styles.label}>Spare-parts seller registry</Text>
      <Muted>Evidence from verified and provisional sellers is accepted automatically; unlisted sellers are reviewed case by case; flagged and removed sellers are refused.</Muted>
      <View style={styles.row}>
        {(['all', 'unlisted', 'provisional', 'verified', 'flagged', 'removed'] as const).map((f) => (
          <Chip key={f} label={f} selected={filter === f} onPress={() => setFilter(f)} />
        ))}
      </View>
      {mergeFrom && <Badge label={`Merging “${mergeFrom.name}” — tap Merge here on the record to keep`} tone="warn" />}
      {sellers.data?.sellers
        .filter((s) => s.status !== 'merged')
        .map((s) => (
          <View key={s.id} style={{ gap: 4, borderTopWidth: 1, borderColor: colors.line, paddingTop: 6 }}>
            <View style={styles.row}>
              <Text style={{ fontWeight: '600', color: colors.ink }}>{s.name}</Text>
              <Badge label={s.status} tone={STATUS_TONE[s.status]} />
            </View>
            <Muted>
              {[s.city, s.phone, s.registration_number].filter(Boolean).join(' · ') || 'No details'} · {s.evidence_count} evidence file(s) · {s.clean_approvals} clean approval(s) ·{' '}
              {s.created_via === 'evidence' ? 'added from evidence' : 'added by admin'}
            </Muted>
            {s.flag_reason ? <Muted>Reason: {s.flag_reason}</Muted> : null}
            <View style={styles.row}>
              {s.status !== 'verified' && <Chip label="Verify" onPress={() => setStatus(s, 'verified')} />}
              {s.status === 'unlisted' && <Chip label="Provisional" onPress={() => setStatus(s, 'provisional')} />}
              {s.status !== 'flagged' && <Chip label="Flag" onPress={() => setStatus(s, 'flagged')} />}
              {s.status !== 'removed' && <Chip label="Remove" onPress={() => setStatus(s, 'removed')} />}
              {!mergeFrom && <Chip label="Merge into…" onPress={() => setMergeFrom(s)} />}
              {mergeFrom && mergeFrom.id !== s.id && (
                <Chip
                  label="Merge here"
                  selected
                  onPress={() =>
                    run(async () => {
                      await api(`/admin/sellers/${mergeFrom.id}/merge`, { body: { intoId: s.id } });
                      setMergeFrom(null);
                    })
                  }
                />
              )}
            </View>
          </View>
        ))}
      {mergeFrom && <Button title="Cancel merge" variant="secondary" onPress={() => setMergeFrom(null)} />}
      <Field label="Reason (for flag / remove)" value={reason} onChangeText={setReason} />

      <Text style={[styles.label, { marginTop: 8 }]}>Add a verified seller</Text>
      <Field label="Name" value={name} onChangeText={setName} />
      <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Field label="City" value={city} onChangeText={setCity} />
      <Field label="Registration / ID number" value={reg} onChangeText={setReg} />
      <Button
        title="Add seller"
        disabled={name.trim().length < 2}
        onPress={() =>
          run(async () => {
            await api('/admin/sellers', {
              body: { name: name.trim(), phone: phone.trim() || undefined, city: city.trim() || undefined, registrationNumber: reg.trim() || undefined },
            });
            setName('');
            setPhone('');
            setCity('');
            setReg('');
          })
        }
      />

      {cfg && (
        <>
          <Text style={[styles.label, { marginTop: 8 }]}>Auto-verification</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ flex: 1 }}>Auto-verify provisional sellers after {cfg.cleanApprovalsRequired} clean approvals</Text>
            <Switch value={cfg.autoVerifyEnabled} onValueChange={(v) => run(() => api('/admin/settings/seller_registry', { method: 'PUT', body: { value: { ...cfg, autoVerifyEnabled: v } } }))} />
          </View>
          <Field label="Clean approvals required" value={autoN} onChangeText={setAutoN} keyboardType="number-pad" placeholder={String(cfg.cleanApprovalsRequired)} />
          <Button
            title="Save threshold"
            variant="secondary"
            disabled={!(Number(autoN) >= 1)}
            onPress={() => run(() => api('/admin/settings/seller_registry', { method: 'PUT', body: { value: { ...cfg, cleanApprovalsRequired: Number(autoN) } } }))}
          />
        </>
      )}
    </Card>
  );
}
