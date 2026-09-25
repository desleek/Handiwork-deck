import type { PerformanceMultiplier } from '@handiwork/shared';

export interface TechCardData {
  id: string;
  fullName: string;
  headline: string | null;
  photoUrl: string | null;
  category: { id: number; name: string; icon: string | null };
  rating: { avg: number; count: number };
  startingPrice: { amountMinor: number; currency: string } | null;
  distanceKm: number | null;
  livePosition: { lat: number; lng: number } | null;
  instantBook: boolean;
  laborStance: string;
  performance: PerformanceMultiplier;
  boosted: boolean;
}

export interface DiscoverResult {
  boosted: TechCardData[];
  organic: TechCardData[];
}
