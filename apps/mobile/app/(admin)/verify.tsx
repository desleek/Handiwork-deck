import { Text, View } from 'react-native';
import { Button, Card, ErrorText, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface PendingTech {
  id: string;
  full_name: string;
  phone_e164: string | null;
  years_experience: number;
  id_document_ids: string[];
}

export default function Verify() {
  const { data, error, loading, reload } = useApi<{ technicians: PendingTech[] }>('/admin/technicians?status=pending');
  if (loading && !data) return <Loading />;
  const decide = (id: string, status: 'verified' | 'rejected') =>
    api(`/admin/technicians/${id}/verification`, { body: { status } }).then(reload);
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.technicians.length === 0 && <Muted>No technicians awaiting verification.</Muted>}
      {data?.technicians.map((t) => (
        <Card key={t.id}>
          <Text style={{ fontWeight: '600' }}>{t.full_name}</Text>
          <Muted>
            {t.phone_e164 ?? 'no phone'} · {t.years_experience} yrs · {t.id_document_ids.length} ID document(s)
          </Muted>
          <View style={styles.row}>
            <Button title="Verify" onPress={() => decide(t.id, 'verified')} />
            <Button title="Reject" variant="secondary" onPress={() => decide(t.id, 'rejected')} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
