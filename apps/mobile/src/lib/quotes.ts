import type { CounterKind, LaborStance, QuoteItemKind } from '@handiwork/shared';

export interface QuoteItem {
  id: string;
  kind: QuoteItemKind;
  description: string;
  quantity: number;
  unit_price_minor: number;
  total_minor: number;
}

export interface Counter {
  id: string;
  kind: CounterKind;
  proposed_total_minor: number;
  proposed_labor_minor: number | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'superseded' | 'withdrawn';
  created_at: string;
}

export interface Quote {
  id: string;
  technician_id: string;
  technician_name: string;
  amount_minor: number;
  labor_minor: number;
  materials_minor: number;
  currency: string;
  message: string | null;
  eta_minutes: number | null;
  status: 'pending' | 'countered' | 'accepted' | 'rejected' | 'withdrawn';
  revision: number;
  labor_only: boolean;
  rating_avg: number;
  rating_count: number;
  labor_stance: LaborStance;
  items: QuoteItem[];
  latest_counter: Counter | null;
}

export const COUNTER_LABEL: Record<CounterKind, string> = {
  labor_only: 'Labor only',
  price_challenge: 'Challenge price',
  labor_negotiation: 'Negotiate labor',
};

export const ITEM_KIND_LABEL: Record<QuoteItemKind, string> = {
  labor: 'Labor',
  material: 'Materials',
  transport: 'Transport',
  other: 'Other',
  adjustment: 'Adjustment',
};
