/** Technicians rate customers after each job on how well they kept to the agreement. */
export const CUSTOMER_RATING_CATEGORIES = ['payment', 'scope', 'materials', 'conduct'] as const;
export type CustomerRatingCategory = (typeof CUSTOMER_RATING_CATEGORIES)[number];

export const CUSTOMER_RATING_LABEL: Record<CustomerRatingCategory, string> = {
  payment: 'Paid as agreed',
  scope: 'Kept to the agreed scope',
  materials: 'Supplied materials as agreed (labor-only jobs)',
  conduct: 'Site access & conduct',
};

/** `materials` only applies to labor-only jobs. */
export function requiredCustomerRatingCategories(laborOnly: boolean): CustomerRatingCategory[] {
  return CUSTOMER_RATING_CATEGORIES.filter((c) => c !== 'materials' || laborOnly);
}
