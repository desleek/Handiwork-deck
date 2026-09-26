import type { UserRole } from './roles';

export const JOB_STATUSES = [
  'open', // posted, visible to matching technicians
  'quoted', // at least one quote received
  'assigned', // customer accepted a quote
  'en_route', // technician travelling (live location shared)
  'in_progress',
  'completed', // technician marked work done, awaiting payment
  'paid', // payment captured and split
  'cancelled',
  'disputed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

interface Transition {
  to: JobStatus;
  /** Roles allowed to trigger this transition directly via the API. */
  by: readonly (UserRole | 'system')[];
}

const T = (to: JobStatus, ...by: Transition['by']): Transition => ({ to, by });

/** The job lifecycle. Anything not listed here is an illegal transition. */
export const JOB_TRANSITIONS: Record<JobStatus, readonly Transition[]> = {
  // open -> assigned directly is instant booking (system books the technician at their listed rate).
  open: [T('quoted', 'system'), T('assigned', 'system'), T('cancelled', 'customer', 'admin')],
  // quoted -> assigned by 'system' happens when a technician accepts the customer's counter-offer.
  quoted: [T('assigned', 'customer', 'system'), T('cancelled', 'customer', 'admin')],
  assigned: [
    // assigned -> open: the technician declined an instant booking; the job returns to the marketplace.
    T('open', 'system'),
    T('en_route', 'technician'),
    T('cancelled', 'customer', 'technician', 'admin'),
    T('disputed', 'customer', 'technician'),
  ],
  en_route: [T('in_progress', 'technician'), T('disputed', 'customer', 'technician')],
  in_progress: [T('completed', 'technician'), T('disputed', 'customer', 'technician')],
  completed: [T('paid', 'system'), T('disputed', 'customer')],
  paid: [T('disputed', 'customer', 'admin')],
  cancelled: [],
  disputed: [T('in_progress', 'admin'), T('completed', 'admin'), T('cancelled', 'admin'), T('paid', 'admin')],
};

export function canTransition(from: JobStatus, to: JobStatus, actor: UserRole | 'system'): boolean {
  return JOB_TRANSITIONS[from].some((t) => t.to === to && t.by.includes(actor));
}

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['assigned', 'en_route', 'in_progress'];

/** pending_exception: a line's markup is above the cap and awaits an admin decision (Demand Notice). */
export const QUOTE_STATUSES = ['pending', 'pending_exception', 'countered', 'accepted', 'rejected', 'withdrawn'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** How the customer engaged: open marketplace post, a request to one technician, or instant book. */
export const BOOKING_MODES = ['open', 'request', 'instant'] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

/** Jobs in these states count as "completed" for the mandatory-review rule. */
export const REVIEWABLE_JOB_STATUSES: readonly JobStatus[] = ['completed', 'paid'];
