/**
 * Section 6c: price-challenge escalation timelines. The standard (non-urgent)
 * timeline runs over 72 hours; Fast Track compresses it into 24 hours.
 */
export interface ChallengeTimeline {
  /** Technician expected to respond by this hour. */
  responseDueHours: number;
  /** Repeating reminders from `responseDueHours` until this hour. */
  remindersUntilHours: number;
  reminderEveryHours: number;
  /** Escalate to admin (+ email and WhatsApp to the technician). */
  adminEscalationHours: number;
  /** Uniform automatic outcome if still unanswered. */
  finalActionHours: number;
}

export const STANDARD_CHALLENGE_TIMELINE: ChallengeTimeline = {
  responseDueHours: 6,
  remindersUntilHours: 30,
  reminderEveryHours: 4,
  adminEscalationHours: 48,
  finalActionHours: 72,
};

export const FAST_TRACK_CHALLENGE_TIMELINE: ChallengeTimeline = {
  responseDueHours: 2,
  remindersUntilHours: 8,
  reminderEveryHours: 1,
  adminEscalationHours: 8,
  finalActionHours: 24,
};

/** What happens at the final hour if the technician never responds (global, not per case). */
export const CHALLENGE_TIMEOUT_ACTIONS = ['auto_approve', 'cancel_redirect_labor_only'] as const;
export type ChallengeTimeoutAction = (typeof CHALLENGE_TIMEOUT_ACTIONS)[number];

export type ChallengeStep = { step: 'reminder'; n: number; atHours: number } | { step: 'escalate'; atHours: number } | { step: 'final'; atHours: number };

/** Every scheduled step of a challenge, in order. */
export function challengeSchedule(t: ChallengeTimeline): ChallengeStep[] {
  const steps: ChallengeStep[] = [];
  let n = 1;
  for (let h = t.responseDueHours; h <= t.remindersUntilHours; h += t.reminderEveryHours) steps.push({ step: 'reminder', n: n++, atHours: h });
  steps.push({ step: 'escalate', atHours: t.adminEscalationHours });
  steps.push({ step: 'final', atHours: t.finalActionHours });
  return steps.sort((a, b) => a.atHours - b.atHours);
}

/** Technician responses to a price challenge. */
export const CHALLENGE_RESPONSES = ['match', 'explain', 'hold_firm'] as const;
export type ChallengeResponse = (typeof CHALLENGE_RESPONSES)[number];
