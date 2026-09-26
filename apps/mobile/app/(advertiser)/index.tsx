import { Text, View } from 'react-native';
import { Badge, Button, Card, ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { PLACEMENT_LABEL, PRICING_LABEL } from '@/lib/marketplace';
import { useApi } from '@/lib/useApi';

interface Campaign {
  id: string;
  title: string;
  placement: 'featured_seller' | 'brand_card' | 'sponsored_search';
  status: string;
  pricing_model: 'flat_daily' | 'cpm' | 'cpc';
  rate_minor: number;
  impressions: number;
  clicks: number;
  budget_minor: number;
  spent_minor: number;
  currency: string;
  review_note: string | null;
  managed_by_admin: boolean;
}


const NEXT: Record<string, { label: string; status: string } | undefined> = {
  draft: { label: 'Submit for review', status: 'pending_review' },
  rejected: { label: 'Resubmit', status: 'pending_review' },
  active: { label: 'Pause', status: 'paused' },
  paused: { label: 'Resume', status: 'active' },
};

/** Section 12: advertisers see their campaigns and results; changes go through our team until self-serve opens. */
export default function Campaigns() {
  const { data, error, loading, reload } = useApi<{ campaigns: Campaign[]; selfServe: boolean }>('/advertiser/campaigns');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data && !data.selfServe && <Muted>Your campaigns are set up and managed by the HANDIWORK-DECK team. Contact us to launch or change one.</Muted>}
      {data?.campaigns.length === 0 && <Muted>No campaigns yet.</Muted>}
      {data?.campaigns.map((c) => {
        const next = NEXT[c.status];
        const ctr = c.impressions ? ((c.clicks / c.impressions) * 100).toFixed(1) : '0.0';
        return (
          <Card key={c.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '600', flex: 1 }}>{c.title}</Text>
              <Badge label={c.status.replace('_', ' ')} tone={c.status === 'active' ? 'good' : c.status === 'rejected' ? 'bad' : 'neutral'} />
            </View>
            <Muted>
              {PLACEMENT_LABEL[c.placement]} · {formatMoney(c.rate_minor, c.currency)} {PRICING_LABEL[c.pricing_model]}
            </Muted>
            <Muted>
              {c.impressions} views · {c.clicks} clicks · {ctr}% CTR · spent {formatMoney(c.spent_minor, c.currency)}
              {c.budget_minor ? ` of ${formatMoney(c.budget_minor, c.currency)}` : ''}
            </Muted>
            {c.review_note ? <Muted>Review note: {c.review_note}</Muted> : null}
            {data.selfServe && !c.managed_by_admin && next && (
              <Button title={next.label} variant="secondary" onPress={() => api(`/advertiser/campaigns/${c.id}/status`, { body: { status: next.status } }).then(reload)} />
            )}
          </Card>
        );
      })}
    </Screen>
  );
}
