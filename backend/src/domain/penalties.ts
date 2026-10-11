/**
 * Incomplete transaction penalties (Section 18), fault-attributed.
 */
export type Party = 'customer' | 'technician' | 'admin' | 'none';

export const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'declined', 'incomplete']);

/**
 * Who must act next for each job status. The API updates `jobs.action_required_from` on every
 * transition using this map, so the "action required from [party]" state is always current.
 */
export const ACTION_REQUIRED: Record<string, { party: Party; reason: string }> = {
  requested: { party: 'technician', reason: 'Accept or decline the booking' },
  accepted: { party: 'technician', reason: 'Submit a quote' },
  quoted: { party: 'customer', reason: 'Approve, counter, or reject the quote' },
  approved: { party: 'customer', reason: 'Complete payment' },
  funded: { party: 'technician', reason: 'Travel to the job' },
  en_route: { party: 'technician', reason: 'Arrive and start the job' },
  in_progress: { party: 'technician', reason: 'Mark the job complete' },
  awaiting_confirmation: { party: 'customer', reason: 'Confirm completion' },
  disputed: { party: 'admin', reason: 'Resolve dispute' },
  completed: { party: 'none', reason: '' },
  cancelled: { party: 'none', reason: '' },
  declined: { party: 'none', reason: '' },
  incomplete: { party: 'none', reason: '' },
  // 'negotiating' is set explicitly by whichever sub-flow is pending (labor-only, challenge, negotiation).
};

export type FaultOutcome =
  | { kind: 'not_stalled' }
  | { kind: 'strike'; party: 'customer' | 'technician' }
  | { kind: 'admin_review' };

/**
 * At timeout, attribute fault to whoever was last prompted. Ambiguous or simultaneous stalls
 * (admin-owned or no clear party) go to the admin review queue.
 */
export function attributeFault(job: {
  status: string;
  actionRequiredFrom: Party;
  actionRequiredSince: Date;
}, now: Date, timeoutDays: number): FaultOutcome {
  if (TERMINAL_STATUSES.has(job.status)) return { kind: 'not_stalled' };
  const stalledMs = now.getTime() - job.actionRequiredSince.getTime();
  if (stalledMs < timeoutDays * 86_400_000) return { kind: 'not_stalled' };
  if (job.actionRequiredFrom === 'customer' || job.actionRequiredFrom === 'technician') {
    return { kind: 'strike', party: job.actionRequiredFrom };
  }
  return { kind: 'admin_review' };
}

/** Tier 1: N at-fault strikes in the rolling window → restriction. */
export function tier1Triggered(strikeDates: Date[], now: Date, windowDays: number, threshold: number): boolean {
  const from = now.getTime() - windowDays * 86_400_000;
  return strikeDates.filter((d) => d.getTime() >= from).length >= threshold;
}

function monthKey(d: Date): number {
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * Tier 2: Tier 1 triggered in each of N consecutive calendar months → full suspension.
 */
export function tier2Triggered(tier1TriggerDates: Date[], consecutiveMonths: number): boolean {
  const months = [...new Set(tier1TriggerDates.map(monthKey))].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < months.length; i++) {
    run = months[i] === months[i - 1] + 1 ? run + 1 : 1;
    if (run >= consecutiveMonths) return true;
  }
  return consecutiveMonths <= 1 && months.length > 0;
}

export function canAppeal(suspendedAt: Date, now: Date, appealWindowDays: number): boolean {
  return now.getTime() - suspendedAt.getTime() <= appealWindowDays * 86_400_000;
}

/** Is a function (e.g. 'create_booking', 'accept_job') blocked by any active restriction? */
export function isRestricted(
  restrictions: { restrictedFunctions: string[]; startsAt: Date; endsAt: Date | null; liftedAt: Date | null }[],
  fn: string,
  now: Date,
): boolean {
  return restrictions.some(
    (r) =>
      !r.liftedAt &&
      r.startsAt <= now &&
      (r.endsAt === null || r.endsAt > now) &&
      (r.restrictedFunctions.includes(fn) || r.restrictedFunctions.includes('*')),
  );
}
