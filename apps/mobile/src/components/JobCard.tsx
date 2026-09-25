import { Text, View } from 'react-native';
import { formatMoney, STATUS_LABEL } from '@/lib/format';
import { Badge, Card, colors, Muted } from './ui';
import type { JobStatus } from '@handiwork/shared';

export interface JobSummary {
  id: string;
  ref: string;
  title: string;
  address: string;
  status: JobStatus;
  budget_minor: number | null;
  currency: string;
  category_name?: string;
  distance_km?: number;
  already_quoted?: boolean;
}

const tone = (s: JobStatus) =>
  s === 'paid' ? 'good' : s === 'cancelled' || s === 'disputed' ? 'bad' : s === 'completed' ? 'warn' : 'neutral';

export function JobCard({ job, onPress }: { job: JobSummary; onPress: () => void }) {
  return (
    <Card onPress={onPress}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ fontSize: 16, fontWeight: '600', color: colors.ink, flex: 1 }}>{job.title}</Text>
        <Muted>#{job.ref}</Muted>
      </View>
      <Muted>
        {job.category_name ? `${job.category_name} · ` : ''}
        {job.distance_km != null ? `${Number(job.distance_km).toFixed(1)} km · ` : ''}
        {job.address}
      </Muted>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Badge label={job.already_quoted ? 'You quoted' : STATUS_LABEL[job.status]} tone={tone(job.status)} />
        {job.budget_minor != null && <Text style={{ fontWeight: '600' }}>{formatMoney(job.budget_minor, job.currency)}</Text>}
      </View>
    </Card>
  );
}
