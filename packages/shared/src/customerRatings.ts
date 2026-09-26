/** Section 7: technicians rate customers on agreement compliance (not mandatory). */
export const CUSTOMER_RATING_CATEGORIES = ['on_site', 'access', 'paid_on_platform', 'conduct'] as const;
export type CustomerRatingCategory = (typeof CUSTOMER_RATING_CATEGORIES)[number];

export const CUSTOMER_RATING_LABEL: Record<CustomerRatingCategory, string> = {
  on_site: 'On site as scheduled',
  access: 'Granted access',
  paid_on_platform: 'Paid through the platform',
  conduct: 'Respectful conduct',
};

/**
 * Platform completion badge: a separate trust indicator for customers who
 * consistently complete jobs and pay in full through the platform.
 */
export function hasCompletionBadge(
  s: { paidJobs: number; engagedJobs: number; refundedOrDisputed: number },
  rule: { minPaidJobs: number; minCompletionRate: number },
): boolean {
  if (s.paidJobs < rule.minPaidJobs || s.engagedJobs === 0) return false;
  return (s.paidJobs - s.refundedOrDisputed) / s.engagedJobs >= rule.minCompletionRate;
}
