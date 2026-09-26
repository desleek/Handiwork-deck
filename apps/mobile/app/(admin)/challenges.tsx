import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Badge, Button, Card, Chip, colors, ErrorText, Field, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface Challenge {
  id: string;
  job_id: string;
  job_ref: string;
  job_title: string;
  technician_name: string;
  customer_name: string;
  fast_track: boolean;
  escalated_at: string | null;
  reminders_sent: number;
  message: string | null;
  response_due_at: string;
  final_action_at: string;
  created_at: string;
  lines: { description: string; current_unit_price_minor: number; proposed_unit_price_minor: number }[];
  evidence: { id: string; url: string | null; seller: string; sellerVerified: boolean }[] | null;
}

/** Section 6c admin queue: Fast Track cases first and visually distinct, then escalated, then oldest. */
export default function Challenges() {
  const { data, error, loading, reload } = useApi<{ challenges: Challenge[] }>('/admin/price-challenges');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.challenges.length === 0 && <Muted>No open price challenges.</Muted>}
      {data?.challenges.map((c) => <ChallengeCard key={c.id} c={c} onDone={reload} />)}
    </Screen>
  );
}

function ChallengeCard({ c, onDone }: { c: Challenge; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const resolve = async (decision: 'approve_customer' | 'uphold_technician') => {
    setError(null);
    try {
      await api(`/admin/price-challenges/${c.id}/resolve`, { body: { decision, note: note.trim() || undefined } });
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card style={c.fast_track ? { borderColor: colors.danger, borderWidth: 2, backgroundColor: '#FFF5F5' } : undefined}>
      <View style={styles.row}>
        {c.fast_track && <Badge label="⚡ FAST TRACK" tone="bad" />}
        {c.escalated_at && <Badge label="Escalated" tone="warn" />}
        <Text style={{ fontWeight: '700', color: colors.ink }} onPress={() => router.push(`/job/${c.job_id}`)}>
          #{c.job_ref} ›
        </Text>
      </View>
      <Muted>
        {c.job_title} · {c.customer_name} vs {c.technician_name} · {c.reminders_sent} reminder(s) sent
      </Muted>
      {c.lines.map((l, i) => (
        <Muted key={i}>
          {l.description}: ₦{(l.current_unit_price_minor / 100).toLocaleString()} → ₦{(l.proposed_unit_price_minor / 100).toLocaleString()}
        </Muted>
      ))}
      {c.message ? <Text>“{c.message}”</Text> : null}
      <View style={styles.row}>
        {c.evidence?.map((e, i) => (
          <Chip key={e.id} label={`${e.seller} ${e.sellerVerified ? '✓' : '(unverified)'} · ${i + 1}`} onPress={() => e.url && WebBrowser.openBrowserAsync(e.url)} />
        ))}
      </View>
      <Muted>Auto-resolves {new Date(c.final_action_at).toLocaleString()}</Muted>
      <Field label="Note (optional)" value={note} onChangeText={setNote} multiline />
      <Button title="Apply customer's prices" onPress={() => resolve('approve_customer')} />
      <Button title="Uphold technician's prices" variant="secondary" onPress={() => resolve('uphold_technician')} />
      <ErrorText error={error} />
    </Card>
  );
}
