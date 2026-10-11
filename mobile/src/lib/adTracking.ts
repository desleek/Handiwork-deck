import { api } from '../api/client';

/**
 * Sponsored / Deals tracking (Section 12). Fire-and-forget: tracking failures are swallowed so the
 * ads module can never affect the screen it sits on. The API de-duplicates per user per day.
 */
const seen = new Set<string>();

export function trackImpression(campaignId: string) {
  if (seen.has(campaignId)) return;
  seen.add(campaignId);
  api(`/ads/${campaignId}/events`, { body: { type: 'impression' } }).catch(() => {});
}

export function trackClick(campaignId: string) {
  api(`/ads/${campaignId}/events`, { body: { type: 'click' } }).catch(() => {});
}
