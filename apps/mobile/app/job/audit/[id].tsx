import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { colors, ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { useApi } from '@/lib/useApi';

interface Entry {
  id: number;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  actor_role: string | null;
}

const LABEL: Record<string, string> = {
  'quote.submitted': 'Quote submitted',
  'quote.revised': 'Quote revised',
  'quote.withdrawn': 'Quote withdrawn',
  'quote.accepted': 'Quote accepted',
  'counter.sent': 'Counter-offer sent',
  'counter.accepted': 'Counter-offer accepted',
  'counter.declined': 'Counter-offer declined',
  'counter.withdrawn': 'Counter-offer withdrawn',
  'cap_exception.requested': 'Markup cap exception requested',
  'cap_exception.approved': 'Markup cap exception approved',
  'cap_exception.declined': 'Markup cap exception declined',
  'receipt.attached': 'Receipt attached',
  'request.accepted': 'Booking request accepted',
  'request.declined': 'Booking request declined',
  'instant.declined': 'Instant booking declined',
  'customer.rated': 'Customer rated',
};

/** Section 5a: the job's audit trail — every request, evidence file and decision. */
export default function AuditTrail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, loading } = useApi<{ entries: Entry[] }>(`/jobs/${id}/audit`);
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.entries.length === 0 && <Muted>Nothing recorded yet.</Muted>}
      {data?.entries.map((e) => (
        <View key={e.id} style={{ borderLeftWidth: 3, borderColor: e.action.startsWith('cap_exception') ? colors.primary : colors.line, paddingLeft: 10, gap: 2 }}>
          <Text style={{ fontWeight: '600', color: colors.ink }}>{LABEL[e.action] ?? e.action}</Text>
          <Muted>
            {new Date(e.created_at).toLocaleString()} · {e.actor_name ? `${e.actor_name} (${e.actor_role})` : 'System'}
          </Muted>
          {typeof e.details.reason === 'string' && <Muted>Reason: {e.details.reason}</Muted>}
          {typeof e.details.note === 'string' && <Muted>Note: {e.details.note}</Muted>}
          {typeof e.details.line === 'string' && <Muted>Line: {e.details.line}</Muted>}
          {typeof e.details.requestedMarkupBps === 'number' && <Muted>Requested markup: {(e.details.requestedMarkupBps as number) / 100}%</Muted>}
          {Array.isArray(e.details.evidenceFileIds) && <Muted>Evidence files: {(e.details.evidenceFileIds as string[]).length}</Muted>}
        </View>
      ))}
    </Screen>
  );
}
