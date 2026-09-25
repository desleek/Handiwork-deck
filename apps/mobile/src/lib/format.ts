import { type JobStatus, toMajor } from '@handiwork/shared';

export function formatMoney(minor: number | null | undefined, currency: string): string {
  if (minor == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(toMajor(minor, currency));
  } catch {
    return `${currency} ${toMajor(minor, currency).toLocaleString()}`;
  }
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  open: 'Finding technicians',
  quoted: 'Quotes received',
  assigned: 'Technician assigned',
  en_route: 'On the way',
  in_progress: 'In progress',
  completed: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
  disputed: 'In dispute',
};
