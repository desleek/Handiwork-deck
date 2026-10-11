/**
 * Advertising module rules (Section 12). Pure functions; the module is a bolt-on, so nothing in
 * the core booking/payment/chat/rating flow imports this file.
 */
export type Placement = 'deals_featured' | 'deals_brand' | 'sponsored_search';

export function priceCampaign(
  placement: Placement,
  days: number,
  perDay: Record<Placement, number>,
  maxDays: number,
): { priceMinor: number } | { error: 'INVALID_DURATION' } {
  if (!Number.isInteger(days) || days < 1 || days > maxDays) return { error: 'INVALID_DURATION' };
  return { priceMinor: perDay[placement] * days };
}

export interface CampaignLike {
  status: string;
  paymentStatus: 'unpaid' | 'paid' | 'waived' | 'refunded';
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * Where a campaign should be right now. Only approved, paid (or fee-waived) campaigns inside
 * their window ever go live; paused/rejected ones never change automatically.
 */
export function nextCampaignStatus(c: CampaignLike, now: Date): string {
  if (['rejected', 'paused', 'ended', 'draft', 'pending_review'].includes(c.status)) return c.status;
  if (c.endsAt && c.endsAt <= now) return 'ended';
  const paid = c.paymentStatus === 'paid' || c.paymentStatus === 'waived';
  if (!paid) return 'approved';
  if (c.startsAt && c.startsAt > now) return 'approved';
  return 'active';
}

export function clickThroughRate(impressions: number, clicks: number): number | null {
  return impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : null;
}
