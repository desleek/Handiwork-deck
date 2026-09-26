import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';
import { iconFor } from '@/lib/categories';
import { CustomerTrust, type Trust } from './CustomerTrust';
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
  category_icon?: string | null;
  needs_review?: boolean;
  /** Technician feed: the customer's agreement compliance and completion badge (Section 7). */
  customer?: Trust;
  distance_km?: number;
  already_quoted?: boolean;
}

const tone = (s: JobStatus) =>
  s === 'paid' ? 'good' : s === 'cancelled' || s === 'disputed' ? 'bad' : s === 'completed' ? 'warn' : 'neutral';

export function JobCard({ job, onPress, highlight }: { job: JobSummary; onPress: () => void; highlight?: string }) {
  return (
    <Card onPress={onPress} style={highlight || job.needs_review ? { borderColor: colors.primary, borderWidth: 1.5 } : undefined}>
      {highlight ? <Text style={{ color: colors.primary, fontWeight: '700', fontSize: 12 }}>{highlight}</Text> : null}
      {job.needs_review ? <Text style={{ color: '#92400E', fontWeight: '700', fontSize: 12 }}>Review required</Text> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Ionicons name={iconFor(job.category_icon)} size={18} color={colors.primary} />
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
      {job.customer && <CustomerTrust trust={job.customer} />}
    </Card>
  );
}
