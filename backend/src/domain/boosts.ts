/**
 * Technician visibility boost & push-alert promotion (Section 16).
 * Eligibility is enforced server-side at purchase time.
 */

export type BoostDenial =
  | 'FEATURE_DISABLED'
  | 'RATING_BELOW_THRESHOLD'
  | 'NO_RATING_YET'
  | 'PRIVILEGES_SUSPENDED'
  | 'ACCOUNT_RESTRICTED'
  | 'RATE_ABOVE_CAP'
  | 'RATE_NOT_FLAT'
  | 'DAILY_ALERT_LIMIT'
  | 'NOT_VERIFIED';

export function checkBoostEligibility(p: {
  featureEnabled: boolean;
  ratingAvg: number | null;
  minRating: number;
  privilegesSuspended: boolean;
  restricted: boolean;
  verified: boolean;
}): BoostDenial | null {
  if (!p.featureEnabled) return 'FEATURE_DISABLED';
  if (!p.verified) return 'NOT_VERIFIED';
  if (p.privilegesSuspended) return 'PRIVILEGES_SUSPENDED';
  if (p.restricted) return 'ACCOUNT_RESTRICTED';
  if (p.ratingAvg === null) return 'NO_RATING_YET';
  if (p.ratingAvg < p.minRating) return 'RATING_BELOW_THRESHOLD';
  return null;
}

/** Plain-language reasons shown in the app (never "error codes" to a technician). */
export const BOOST_DENIAL_TEXT: Record<BoostDenial, string> = {
  FEATURE_DISABLED: 'Promotions are not available yet.',
  NOT_VERIFIED: 'Your account needs to be verified first.',
  PRIVILEGES_SUSPENDED: 'Promotions are paused on your account while it is under review.',
  ACCOUNT_RESTRICTED: 'Promotions are paused while your account is restricted.',
  NO_RATING_YET: 'Complete a few jobs and get rated to unlock promotions.',
  RATING_BELOW_THRESHOLD: 'Promotions unlock once your rolling rating reaches the minimum (3★ by default).',
  RATE_ABOVE_CAP: 'That rate is above the maximum allowed.',
  RATE_NOT_FLAT: 'Boosts are sold at the standard hourly rate.',
  DAILY_ALERT_LIMIT: 'You have used all of today\'s availability alerts.',
};

/** Two boosts for the same technician and category may not overlap in time. */
export function overlaps(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export function priceProfileBoost(p: {
  ratePerHourMinor: number;
  hours: number;
  capMinor: number;
  mode: 'flat' | 'variable';
}): { totalMinor: number } | { error: BoostDenial } {
  if (p.mode === 'flat' && p.ratePerHourMinor !== p.capMinor) return { error: 'RATE_NOT_FLAT' };
  if (p.ratePerHourMinor > p.capMinor || p.ratePerHourMinor <= 0) return { error: 'RATE_ABOVE_CAP' };
  return { totalMinor: p.ratePerHourMinor * p.hours };
}

export function canSendAlertToday(alertsSentLast24h: number, maxPerDay: number): boolean {
  return alertsSentLast24h < maxPerDay;
}

/** Fixed platform template — no free text, to keep alerts honest (Section 16b). */
export function alertMessage(p: { name: string; category: string; rating: number; distanceKm: number }) {
  return {
    title: `${p.category} pro available now`,
    body: `${p.name} (${p.rating.toFixed(1)}★) is online and ${p.distanceKm.toFixed(1)} km away.`,
  };
}

/** A boost that was paid for keeps running to its end even if the rating later drops. */
export function boostIsLive(b: { status: string; startsAt: Date; endsAt: Date }, now: Date): boolean {
  return (b.status === 'scheduled' || b.status === 'active') && b.startsAt <= now && b.endsAt > now;
}
