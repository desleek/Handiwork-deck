import { Text, View } from 'react-native';
import { Button, Card, ErrorText, Loading, Muted, Screen, styles } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

interface Ad {
  id: string;
  title: string;
  body: string | null;
  click_url: string | null;
}

export default function AdReview() {
  const { data, error, loading, reload } = useApi<{ ads: Ad[] }>('/admin/ads?status=pending_review');
  if (loading && !data) return <Loading />;
  const review = (id: string, decision: 'approve' | 'reject') => api(`/admin/ads/${id}/review`, { body: { decision } }).then(reload);
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.ads.length === 0 && <Muted>No campaigns awaiting review.</Muted>}
      {data?.ads.map((ad) => (
        <Card key={ad.id}>
          <Text style={{ fontWeight: '600' }}>{ad.title}</Text>
          {ad.body ? <Text>{ad.body}</Text> : null}
          {ad.click_url ? <Muted>{ad.click_url}</Muted> : null}
          <View style={styles.row}>
            <Button title="Approve" onPress={() => review(ad.id, 'approve')} />
            <Button title="Reject" variant="secondary" onPress={() => review(ad.id, 'reject')} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
