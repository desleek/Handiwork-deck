import { Text, View } from 'react-native';
import { Badge, Button, Card, ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Ad {
  id: string;
  title: string;
  status: string;
  impressions: number;
  clicks: number;
  budget_minor: number;
  spent_minor: number;
  currency: string;
}

const NEXT: Record<string, { label: string; status: string } | undefined> = {
  draft: { label: 'Submit for review', status: 'pending_review' },
  rejected: { label: 'Resubmit', status: 'pending_review' },
  active: { label: 'Pause', status: 'paused' },
  paused: { label: 'Resume', status: 'active' },
};

export default function Campaigns() {
  const { data, error, loading, reload } = useApi<{ ads: Ad[] }>('/ads/mine');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.ads.length === 0 && <Muted>Create a campaign to show your spare parts to customers and technicians.</Muted>}
      {data?.ads.map((ad) => {
        const next = NEXT[ad.status];
        const ctr = ad.impressions ? ((ad.clicks / ad.impressions) * 100).toFixed(1) : '0.0';
        return (
          <Card key={ad.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '600', flex: 1 }}>{ad.title}</Text>
              <Badge label={ad.status.replace('_', ' ')} tone={ad.status === 'active' ? 'good' : ad.status === 'rejected' ? 'bad' : 'neutral'} />
            </View>
            <Muted>
              {ad.impressions} views · {ad.clicks} clicks · {ctr}% CTR
            </Muted>
            <Muted>Budget {ad.budget_minor ? formatMoney(ad.budget_minor, ad.currency) : 'unlimited'}</Muted>
            {next && <Button title={next.label} variant="secondary" onPress={() => api(`/ads/${ad.id}/status`, { body: { status: next.status } }).then(reload)} />}
          </Card>
        );
      })}
    </Screen>
  );
}
