/**
 * Labor-only counter rules (Section 6b).
 */
export type Stance = 'accept' | 'decline_from_inception';

export interface RejectionOutcome {
  /** Whether this rejection counts against the technician for this category. */
  countsAsRejection: boolean;
  /** Rejections in the rolling window including this one. */
  rejectionsInWindow: number;
  /** Whether the cap is now exceeded → apply rating penalty and flag the technician. */
  penaltyApplies: boolean;
}

/**
 * @param stance           The technician's declared stance for the category at the time of the request.
 * @param priorRejections  Counted rejections already in the rolling window for this category.
 */
export function evaluateLaborOnlyRejection(stance: Stance, priorRejections: number, cap: number): RejectionOutcome {
  if (stance === 'decline_from_inception') {
    return { countsAsRejection: false, rejectionsInWindow: priorRejections, penaltyApplies: false };
  }
  const total = priorRejections + 1;
  return { countsAsRejection: true, rejectionsInWindow: total, penaltyApplies: total > cap };
}

export interface StanceSwitchCheck {
  allowed: boolean;
  nextAllowedAt: Date;
}

/** Technicians can switch stance later, subject to a cooldown between switches. */
export function canSwitchStance(lastChangedAt: Date, now: Date, cooldownDays: number): StanceSwitchCheck {
  const nextAllowedAt = new Date(lastChangedAt.getTime() + cooldownDays * 86_400_000);
  return { allowed: now >= nextAllowedAt, nextAllowedAt };
}

export function windowStart(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
