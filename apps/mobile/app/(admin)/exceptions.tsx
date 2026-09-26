import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { pct } from '@/lib/quotes';
import { useApi } from '@/lib/useApi';

interface Case {
  id: string;
  job_id: string;
  job_ref: string;
  job_title: string;
  technician_id: string;
  technician_name: string;
  line_description: string;
  base_minor: number;
  currency: string;
  requested_markup_bps: number;
  cap_bps: number;
  reason: string;
  evidence: { id: string; url: string | null }[];
  markup_cap_bps_override: number | null;
  technician_approved_count: number;
  technician_declined_count: number;
  created_at: string;
}

/** Section 5a: Demand Notice (markup cap exception) cases. */
export default function Exceptions() {
  const { data, error, loading, reload } = useApi<{ cases: Case[] }>('/admin/cap-exceptions');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.cases.length === 0 && <Muted>No markup cap exceptions waiting.</Muted>}
      {data?.cases.map((c) => <CaseCard key={c.id} c={c} onDone={reload} />)}
    </Screen>
  );
}

function CaseCard({ c, onDone }: { c: Case; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [override, setOverride] = useState(String(c.requested_markup_bps / 100));
  const [showOverride, setShowOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const extra = Math.round((c.base_minor * (c.requested_markup_bps - c.cap_bps)) / 10_000);
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontWeight: '700', color: colors.ink }} onPress={() => router.push(`/job/${c.job_id}`)}>
          #{c.job_ref} ›
        </Text>
        <Badge label={`${pct(c.requested_markup_bps)} vs cap ${pct(c.cap_bps)}`} tone="warn" />
      </View>
      <Muted>
        {c.job_title} · {c.technician_name} ({c.technician_approved_count} approved / {c.technician_declined_count} declined before)
      </Muted>
      <Text style={{ color: colors.ink }}>
        “{c.line_description}” — base {formatMoney(c.base_minor, c.currency)}; +{formatMoney(extra, c.currency)} above the cap
      </Text>
      <Text style={{ color: colors.ink }}>Reason: {c.reason}</Text>
      <View style={styles.row}>
        {c.evidence.map((e, i) => (
          <Chip key={e.id} label={`Evidence ${i + 1}`} onPress={() => e.url && WebBrowser.openBrowserAsync(e.url)} />
        ))}
      </View>
      <Field label="Note to technician (optional)" value={note} onChangeText={setNote} multiline />
      <Button title="Approve for this invoice" loading={busy === 'approve'} onPress={() => run('approve', () => api(`/admin/cap-exceptions/${c.id}/decide`, { body: { decision: 'approve', note: note.trim() || undefined } }))} />
      <Button
        title={`Decline (line capped at ${pct(c.cap_bps)})`}
        variant="secondary"
        loading={busy === 'decline'}
        onPress={() => run('decline', () => api(`/admin/cap-exceptions/${c.id}/decide`, { body: { decision: 'decline', note: note.trim() || undefined } }))}
      />
      <Chip label={showOverride ? 'Hide permanent override' : 'Grant a permanent cap override…'} onPress={() => setShowOverride((v) => !v)} />
      {showOverride && (
        <View style={{ gap: 6 }}>
          <Muted>
            Raises {c.technician_name}'s cap on all future quotes (current: {c.markup_cap_bps_override != null ? pct(c.markup_cap_bps_override) : 'platform default'}). This case still needs its own decision.
          </Muted>
          <Field label="Permanent cap %" value={override} onChangeText={setOverride} keyboardType="decimal-pad" />
          <Button
            title="Save override"
            variant="secondary"
            loading={busy === 'override'}
            onPress={() => run('override', () => api(`/admin/technicians/${c.technician_id}/markup-cap`, { method: 'PUT', body: { capBps: Math.round(Number(override) * 100) } }))}
          />
        </View>
      )}
      <ErrorText error={error} />
    </Card>
  );
}
