export interface Category {
  id: string;
  supercategory: 'household_office' | 'construction';
  name: string;
  slug: string;
  icon: string;
}

export type DiscoveryItem =
  | {
      type: 'technician';
      label: 'Promoted' | null;
      id: string;
      name: string;
      avatarUrl: string | null;
      photoUrl: string | null;
      category: { id: string; name: string; icon: string };
      ratingAvg: number | null;
      ratingCount: number;
      startingPriceMinor: number;
      laborOnlyStance: 'accept' | 'decline_from_inception';
      isOnline: boolean;
      distanceKm: number | null;
      liveLocation: { lat: number; lng: number } | null;
    }
  | { type: 'sponsored'; label: 'Sponsored'; ad: { id: string; title: string; body?: string; image_url: string; click_url?: string; seller_name?: string } };

export interface QuoteLine {
  id: string;
  position: number;
  kind: 'labor' | 'part';
  description: string;
  quantity: number;
  rateMinor?: number;
  standardRateMinor?: number | null;
  baseUnitCostMinor?: number;
  markupBps?: number;
  markupMinor?: number;
  receiptUrl?: string | null;
  lineTotalMinor: number;
}

export interface Quote {
  id: string;
  version: number;
  status: 'submitted' | 'pending_exception' | 'approved';
  laborOnly: boolean;
  notes: string | null;
  performanceMultiplierBps: number;
  lines: QuoteLine[];
  totals: {
    laborMinor: number;
    partsBaseMinor: number;
    markupMinor: number;
    totalMinor: number;
    platformFeesIncludedMinor?: number;
    platformFees?: { laborCommissionMinor: number; markupCommissionMinor: number; totalMinor: number };
    technicianNetMinor?: number;
  };
}

export type JobStatus =
  | 'requested' | 'accepted' | 'quoted' | 'negotiating' | 'approved' | 'funded' | 'en_route'
  | 'in_progress' | 'awaiting_confirmation' | 'completed' | 'cancelled' | 'declined' | 'incomplete' | 'disputed';

export interface JobDetail {
  id: string;
  short_code: string;
  kind: 'standard' | 'construction';
  status: JobStatus;
  booking_type: 'instant' | 'request';
  is_fast_track: boolean;
  description: string;
  address: string;
  scheduled_for: string | null;
  action_required_from: 'customer' | 'technician' | 'admin' | 'none';
  action_required_reason: string | null;
  viewer: 'customer' | 'technician' | 'admin';
  category: { id: string; name: string; icon: string };
  customer: { id: string; name: string; phone: string | null; completionBadge: boolean; record: { ratings: number; overall: number | null; on_site: number | null; access: number | null; paid_on_platform: number | null; respectful: number | null } | null };
  technician: { id: string; name: string; avatarUrl: string | null; ratingAvg: number | null; ratingCount: number; phone: string | null; liveLocation: { lat: number; lng: number; at: string } | null };
  quote: Quote | null;
  laborOnlyRequests: { id: string; status: 'pending' | 'accepted' | 'rejected'; stance_at_request: string }[];
  priceChallenges: { id: string; status: string; quote_item_id: string; claimed_unit_cost_minor: number; is_fast_track: boolean; seller_name: string | null; unlisted_seller_name: string | null; response_note: string | null; submitted_at: string }[];
  laborNegotiation: { id: string; status: string; standard_labor_minor: number; proposed_labor_minor: number; counter_labor_minor: number | null; final_labor_minor: number | null } | null;
  capExceptions: { id: string; status: string; requested_markup_bps: number; decision_note: string | null }[];
  reviewSubmitted: boolean;
}

export interface JobSummary {
  id: string;
  short_code: string;
  status: JobStatus;
  is_fast_track: boolean;
  kind?: 'standard' | 'construction';
  booking_type?: 'instant' | 'request';
  scheduled_for?: string | null;
  description: string;
  category_name: string;
  category_icon: string;
  counterpart_name: string;
  action_required_from: string;
  action_required_reason: string | null;
  quote_total_minor: number | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  sender_id: string | null;
  body: string;
  channel: 'app' | 'whatsapp' | 'system';
  redacted: boolean;
  created_at: string;
  pending?: boolean;
}
