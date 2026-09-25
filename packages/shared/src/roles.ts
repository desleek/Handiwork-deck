export const USER_ROLES = ['customer', 'technician', 'advertiser', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Who the customer is booking on behalf of. */
export const CUSTOMER_TYPES = ['homeowner', 'office', 'sme'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/**
 * The two supply-side verticals: household/office technicians (plumbers,
 * electricians, AC repair, IT support…) and construction / plant-erection
 * trades (masons, welders, scaffolders, crane & plant operators…).
 */
export const SERVICE_SEGMENTS = ['household_office', 'construction_plant'] as const;
export type ServiceSegment = (typeof SERVICE_SEGMENTS)[number];

export const VERIFICATION_STATUSES = ['pending', 'verified', 'rejected', 'suspended'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
