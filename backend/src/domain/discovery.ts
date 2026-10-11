/**
 * Discovery grid ranking (Sections 3, 12, 14, 16).
 *  - Boosted technicians appear above organic results, clearly labeled.
 *  - Among boosted: highest bid first, then rating — or even rotation (admin setting).
 *  - Sponsored ad slots (if the ads module is on) are interleaved at most 1 per N organic results.
 */

export interface Candidate {
  id: string;
  ratingAvg: number | null;
  ratingCount: number;
  distanceKm: number | null;
  isOnline: boolean;
  boostRateMinor: number | null; // non-null = live boost in this category
}

export type ListingLabel = 'promoted' | 'sponsored' | null;

export interface RankedListing<T> {
  item: T;
  label: ListingLabel;
}

/** Organic score: rating (with a small-sample prior), presence, and distance. */
export function organicScore(c: Candidate): number {
  const prior = 3.5;
  const k = 5;
  const bayes = ((c.ratingAvg ?? prior) * c.ratingCount + prior * k) / (c.ratingCount + k);
  const distancePenalty = c.distanceKm === null ? 0 : Math.min(c.distanceKm, 50) * 0.02;
  return bayes + (c.isOnline ? 0.3 : 0) - distancePenalty;
}

/** Deterministic rotation seed so a boost queue rotates fairly over time (e.g. per hour). */
function rotate<T>(arr: T[], seed: number): T[] {
  if (arr.length === 0) return arr;
  const s = seed % arr.length;
  return [...arr.slice(s), ...arr.slice(0, s)];
}

export function rankCandidates<T extends Candidate>(
  candidates: T[],
  tieBreak: 'highest_bid_then_rating' | 'even_rotation',
  rotationSeed = 0,
): RankedListing<T>[] {
  const boosted = candidates.filter((c) => c.boostRateMinor !== null);
  const organic = candidates.filter((c) => c.boostRateMinor === null);

  const boostedSorted =
    tieBreak === 'highest_bid_then_rating'
      ? [...boosted].sort(
          (a, b) => (b.boostRateMinor! - a.boostRateMinor!) || ((b.ratingAvg ?? 0) - (a.ratingAvg ?? 0)),
        )
      : rotate([...boosted].sort((a, b) => a.id.localeCompare(b.id)), rotationSeed);

  const organicSorted = [...organic].sort((a, b) => organicScore(b) - organicScore(a));

  return [
    ...boostedSorted.map((item) => ({ item, label: 'promoted' as const })),
    ...organicSorted.map((item) => ({ item, label: null })),
  ];
}

/**
 * Interleave sponsored ad results: at most `maxPerOrganic` → 1 sponsored slot per that many organic results.
 * Sponsored entries are a separate type so the client can never render them as a technician match.
 */
export function interleaveSponsored<T, A>(
  listings: RankedListing<T>[],
  ads: A[],
  maxPerOrganic: number,
): ({ type: 'listing'; listing: RankedListing<T> } | { type: 'sponsored'; ad: A })[] {
  const out: ({ type: 'listing'; listing: RankedListing<T> } | { type: 'sponsored'; ad: A })[] = [];
  let organicSinceAd = 0;
  let adIdx = 0;
  for (const listing of listings) {
    out.push({ type: 'listing', listing });
    if (listing.label === null) organicSinceAd++;
    if (organicSinceAd === maxPerOrganic && adIdx < ads.length) {
      out.push({ type: 'sponsored', ad: ads[adIdx++] });
      organicSinceAd = 0;
    }
  }
  return out;
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
