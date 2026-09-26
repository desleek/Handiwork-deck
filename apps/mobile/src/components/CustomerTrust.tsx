import { Text, View } from 'react-native';
import { Badge, colors, Muted } from './ui';

export interface Trust {
  ratingAvg: number | null;
  ratingCount: number;
  paidJobs: number;
  completionBadge: boolean;
}

/** Section 7: what technicians see about a customer before accepting their booking. */
export function CustomerTrust({ name, trust }: { name?: string; trust: Trust }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {name ? <Text style={{ color: colors.ink }}>{name}</Text> : null}
      {trust.completionBadge && <Badge label="✓ Completes & pays on platform" tone="good" />}
      <Muted>
        {trust.ratingCount ? `Agreement compliance ★ ${Number(trust.ratingAvg).toFixed(1)} (${trust.ratingCount})` : 'No compliance ratings yet'} · {trust.paidJobs} paid job(s)
      </Muted>
    </View>
  );
}
