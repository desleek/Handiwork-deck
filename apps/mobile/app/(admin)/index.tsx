import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Badge, Button, Card, ErrorText, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface Stats {
  customers: number;
  technicians: number;
  pending_verifications: number;
  open_jobs: number;
  active_jobs: number;
  open_escalations: number;
}
interface Escalation {
  id: number;
  job_id: string;
  ref: string;
  title: string;
  kind: string;
  level: number;
  job_status: string;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  no_quote_widen: 'No quotes — search widened',
  no_quote_admin: 'No quotes — needs manual matching',
  no_show: 'Technician not en route',
};

export default function Operations() {
  const stats = useApi<{ stats: Stats }>('/admin/stats');
  const esc = useApi<{ escalations: Escalation[] }>('/admin/escalations');
  if (stats.loading && !stats.data) return <Loading />;
  const s = stats.data?.stats;
  return (
    <Screen>
      <ErrorText error={stats.error ?? esc.error} />
      {s && (
        <View style={styles.row}>
          {(
            [
              ['Customers', s.customers],
              ['Technicians', s.technicians],
              ['Pending verification', s.pending_verifications],
              ['Open jobs', s.open_jobs],
              ['Active jobs', s.active_jobs],
              ['Escalations', s.open_escalations],
            ] as const
          ).map(([label, n]) => (
            <Card key={label} style={{ width: '31%' }}>
              <Text style={{ fontSize: 20, fontWeight: '700' }}>{n}</Text>
              <Muted>{label}</Muted>
            </Card>
          ))}
        </View>
      )}
      <Text style={styles.label}>Open escalations</Text>
      {esc.data?.escalations.length === 0 && <Muted>Nothing needs attention.</Muted>}
      {esc.data?.escalations.map((e) => (
        <Card key={e.id} onPress={() => router.push(`/job/${e.job_id}`)}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '600' }}>#{e.ref}</Text>
            <Badge label={`Level ${e.level}`} tone={e.level > 1 ? 'bad' : 'warn'} />
          </View>
          <Text>{e.title}</Text>
          <Muted>
            {KIND_LABEL[e.kind] ?? e.kind} · job {e.job_status}
          </Muted>
          <Button title="Mark resolved" variant="secondary" onPress={() => api(`/admin/escalations/${e.id}/resolve`, { method: 'POST' }).then(esc.reload)} />
        </Card>
      ))}
    </Screen>
  );
}
