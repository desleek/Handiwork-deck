import { performanceMultiplier, type PerformanceMultiplier } from '@handiwork/shared';
import { type Queryable, pool, query } from '../db/pool';

interface StatsRow {
  technician_id: string;
  rating_avg: number;
  rating_count: number;
  completed_jobs: number;
  technician_cancellations: number;
  disputes: number;
}

export function multiplierFromRow(r: Omit<StatsRow, 'technician_id'>): PerformanceMultiplier {
  return performanceMultiplier({
    ratingAvg: Number(r.rating_avg),
    ratingCount: r.rating_count,
    completedJobs: r.completed_jobs,
    technicianCancellations: r.technician_cancellations,
    disputes: r.disputes,
  });
}

export async function performanceFor(technicianIds: string[], db: Queryable = pool): Promise<Map<string, PerformanceMultiplier>> {
  if (!technicianIds.length) return new Map();
  const rows = await query<StatsRow>('SELECT * FROM technician_performance_stats WHERE technician_id = ANY($1)', [technicianIds], db);
  return new Map(rows.map((r) => [r.technician_id, multiplierFromRow(r)]));
}
