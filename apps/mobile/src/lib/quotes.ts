import type { CounterKind, LaborOnlyPolicy, QuoteItemKind } from '@handiwork/shared';

export interface QuoteItem {
  id: string;
  kind: QuoteItemKind;
  description: string;
  quantity: number;
  unit_price_minor: number;
  base_minor: number;
  markup_bps: number;
  markup_minor: number;
  total_minor: number;
  applies_to: 'labor' | 'markup' | null;
  receipt_file_id: string | null;
}

export interface Counter {
  id: string;
  kind: CounterKind;
  proposed_total_minor: number;
  proposed_labor_minor: number | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'countered' | 'superseded' | 'withdrawn';
  awaiting: 'customer' | 'technician';
  created_by_role: 'customer' | 'technician';
  created_at: string;
}

export interface CapException {
  id: string;
  quote_item_id: string | null;
  line_description: string;
  requested_markup_bps: number;
  cap_bps: number;
  status: 'pending' | 'approved' | 'declined';
  admin_note: string | null;
}

export interface Quote {
  id: string;
  technician_id: string;
  technician_name: string;
  amount_minor: number;
  labor_minor: number;
  materials_minor: number;
  parts_base_minor: number;
  markup_minor: number;
  currency: string;
  message: string | null;
  eta_minutes: number | null;
  status: 'pending' | 'pending_exception' | 'countered' | 'accepted' | 'rejected' | 'withdrawn';
  revision: number;
  labor_only: boolean;
  rating_avg: number;
  rating_count: number;
  labor_only_policy: LaborOnlyPolicy;
  performance_adjustment_bps: number;
  items: QuoteItem[];
  latest_counter: Counter | null;
  cap_exceptions: CapException[];
}

export interface Pricing {
  markupCapBps: number;
  commission: { laborBps: number; markupBps: number };
  receiptThresholdMinor: Record<string, number>;
}

export const COUNTER_LABEL: Record<CounterKind, string> = {
  labor_only: 'Labor only',
  price_challenge: 'Price challenge',
  labor_negotiation: 'Labor cost proposal',
};

export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
