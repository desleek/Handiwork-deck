import { toMinor } from '@handiwork/shared';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { api, uploadFile } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { Quote } from '@/lib/quotes';
import { useApi } from '@/lib/useApi';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Muted, styles } from './ui';

interface Seller {
  id: string;
  name: string;
  city: string | null;
}

/**
 * Section 6c (customer): challenge part prices with an invoice / price proof
 * from a verified registry seller. Fast Track compresses the timeline to 24h.
 */
export function PriceChallengeForm({ jobId, quote, onCancel, onDone }: { jobId: string; quote: Quote; onCancel: () => void; onDone: () => void }) {
  const parts = quote.items.filter((i) => i.kind === 'material');
  const [search, setSearch] = useState('');
  const { data } = useApi<{ sellers: Seller[] }>(`/sellers${search ? `?q=${encodeURIComponent(search)}` : ''}`);
  const [seller, setSeller] = useState<Seller | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [fastTrack, setFastTrack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const lines = parts
    .filter((p) => prices[p.id])
    .map((p) => ({ itemId: p.id, proposedUnitPriceMinor: toMinor(Number(prices[p.id]), quote.currency) }));

  const addEvidence = async () => {
    if (!seller) return setError(new Error('Choose the verified seller first'));
    setError(null);
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const a = r.assets?.[0];
      if (r.canceled || !a) return;
      // Rejected by the server unless the seller is in the verified registry.
      const id = await uploadFile(a.uri, 'price_evidence', a.mimeType ?? 'image/jpeg', { sellerId: seller.id });
      setEvidence((e) => [...e, id]);
    } catch (e) {
      setError(e);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/jobs/${jobId}/quotes/${quote.id}/price-challenges`, { body: { lines, evidenceFileIds: evidence, message: message.trim() || undefined, fastTrack } });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>Challenge parts prices</Text>
      <Muted>Upload an invoice or price quote from a verified spare-parts seller. The technician can match it, explain the difference, or hold firm.</Muted>
      {parts.map((p) => (
        <Field
          key={p.id}
          label={`${p.description} — quoted ${formatMoney(p.unit_price_minor, quote.currency)} each`}
          value={prices[p.id] ?? ''}
          onChangeText={(v) => setPrices((x) => ({ ...x, [p.id]: v }))}
          keyboardType="decimal-pad"
          placeholder={`Seller's price (${quote.currency})`}
        />
      ))}
      <Field label="Verified seller" value={search} onChangeText={setSearch} placeholder="Search the seller registry" />
      <View style={styles.row}>
        {data?.sellers.map((s) => (
          <Chip key={s.id} label={`${s.name}${s.city ? ` · ${s.city}` : ''}`} selected={seller?.id === s.id} onPress={() => setSeller(s)} />
        ))}
      </View>
      <View style={styles.row}>
        <Badge label={`${evidence.length} evidence file(s)`} tone={evidence.length ? 'good' : 'warn'} />
        <Chip label="Upload invoice / price proof" onPress={addEvidence} />
      </View>
      <Field label="Message (optional)" value={message} onChangeText={setMessage} multiline />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: '600', color: colors.ink }}>Fast Track (urgent job)</Text>
          <Muted>Resolved within 24 hours instead of 72.</Muted>
        </View>
        <Switch value={fastTrack} onValueChange={setFastTrack} />
      </View>
      <Button title="Submit challenge" loading={busy} disabled={!lines.length || !evidence.length} onPress={submit} />
      <Button title="Cancel" variant="secondary" onPress={onCancel} />
      <ErrorText error={error} />
    </View>
  );
}

interface Challenge {
  id: string;
  status: string;
  fast_track: boolean;
  message: string | null;
  technician_response: string | null;
  response_due_at: string;
  final_action_at: string;
  escalated_at: string | null;
  lines: { quote_item_id: string; description: string; current_unit_price_minor: number; proposed_unit_price_minor: number }[];
  evidence: { id: string; url: string | null; seller: string }[] | null;
}

const STATUS: Record<string, string> = {
  pending: 'Awaiting technician',
  matched: 'Matched by technician',
  explained: 'Technician explained',
  held_firm: 'Technician held firm',
  auto_approved: 'Auto-approved (no response)',
  auto_cancelled: 'Closed (no response)',
  admin_approved: 'Approved by HANDIWORK',
  admin_upheld: 'Technician upheld by HANDIWORK',
  withdrawn: 'Withdrawn',
  superseded: 'Superseded',
};

/** Challenges on a job, with the technician's match / explain / hold-firm response. */
export function PriceChallengePanel({ jobId, currency, role, onChange }: { jobId: string; currency: string; role: 'customer' | 'technician' | 'admin'; onChange: () => void }) {
  const { data, reload } = useApi<{ challenges: Challenge[] }>(`/jobs/${jobId}/price-challenges`);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!data?.challenges.length) return null;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setMessage('');
      await reload();
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <Text style={styles.label}>Parts price challenges</Text>
      {data.challenges.map((c) => (
        <View key={c.id} style={{ gap: 4, borderTopWidth: 1, borderColor: colors.line, paddingTop: 6 }}>
          <View style={styles.row}>
            <Badge label={STATUS[c.status] ?? c.status} tone={c.status === 'pending' ? 'warn' : 'neutral'} />
            {c.fast_track && <Badge label="URGENT · Fast Track" tone="bad" />}
            {c.escalated_at && c.status === 'pending' && <Badge label="Escalated to admin" tone="bad" />}
          </View>
          {c.lines.map((l) => (
            <Muted key={l.quote_item_id}>
              {l.description}: {formatMoney(l.current_unit_price_minor, currency)} → {formatMoney(l.proposed_unit_price_minor, currency)}
            </Muted>
          ))}
          {c.evidence?.map((e) => (
            <Muted key={e.id}>Evidence from {e.seller}</Muted>
          ))}
          {c.message ? <Muted>Customer: “{c.message}”</Muted> : null}
          {c.technician_response ? <Muted>Technician: “{c.technician_response}”</Muted> : null}
          {c.status === 'pending' && (
            <Muted>
              Response due {new Date(c.response_due_at).toLocaleString()} · auto-resolves {new Date(c.final_action_at).toLocaleString()}
            </Muted>
          )}
          {c.status === 'pending' && role === 'technician' && (
            <>
              <Button title="Match the seller's price" loading={busy === 'match'} onPress={() => act('match', () => api(`/price-challenges/${c.id}/respond`, { body: { response: 'match' } }))} />
              <Field label="Explain the difference" value={message} onChangeText={setMessage} multiline placeholder="e.g. Genuine brand vs. the imitation listed" />
              <Button
                title="Send explanation"
                variant="secondary"
                disabled={!message.trim()}
                loading={busy === 'explain'}
                onPress={() => act('explain', () => api(`/price-challenges/${c.id}/respond`, { body: { response: 'explain', message: message.trim() } }))}
              />
              <Button title="Hold firm" variant="secondary" loading={busy === 'hold'} onPress={() => act('hold', () => api(`/price-challenges/${c.id}/respond`, { body: { response: 'hold_firm' } }))} />
            </>
          )}
          {c.status === 'pending' && role === 'customer' && (
            <Button title="Withdraw challenge" variant="secondary" loading={busy === 'withdraw'} onPress={() => act('withdraw', () => api(`/price-challenges/${c.id}/withdraw`, { method: 'POST' }))} />
          )}
        </View>
      ))}
      <ErrorText error={error} />
    </Card>
  );
}

