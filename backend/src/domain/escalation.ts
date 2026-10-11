/**
 * Price-challenge escalation timeline (Section 6c), standard and Fast Track.
 * Produces a schedule of delayed actions that the BullMQ worker enqueues when a challenge is
 * submitted. Each action re-checks the challenge state before doing anything, so a technician
 * responding at any point silently cancels the remaining steps.
 */
import type { EscalationTimeline } from './settings.ts';

export type EscalationAction =
  | { type: 'notify_technician'; hour: number; reason: 'submitted' | 'reminder' }
  | { type: 'escalate_to_admin'; hour: number }
  | { type: 'final_action'; hour: number };

export function buildSchedule(t: EscalationTimeline): EscalationAction[] {
  const steps: EscalationAction[] = [{ type: 'notify_technician', hour: 0, reason: 'submitted' }];
  for (let h = t.remindFromHours; h <= t.remindUntilHours; h += t.remindEveryHours) {
    if (h === 0) continue;
    steps.push({ type: 'notify_technician', hour: h, reason: 'reminder' });
  }
  steps.push({ type: 'escalate_to_admin', hour: t.escalateAtHours });
  steps.push({ type: 'final_action', hour: t.finalActionAtHours });
  return steps.sort((a, b) => a.hour - b.hour);
}

export function scheduleDelays(t: EscalationTimeline, submittedAt: Date, now: Date) {
  return buildSchedule(t).map((step) => ({
    step,
    runAt: new Date(submittedAt.getTime() + step.hour * 3_600_000),
    delayMs: Math.max(0, submittedAt.getTime() + step.hour * 3_600_000 - now.getTime()),
  }));
}

/** Statuses in which escalation steps still apply (no technician response yet). */
export const AWAITING_TECHNICIAN = new Set(['open', 'escalated']);

export type FinalActionRule = 'auto_approve_customer_evidence' | 'auto_cancel_redirect_labor_only';

/** The rule is uniform and global — never chosen case-by-case. */
export function finalActionStatus(rule: FinalActionRule): 'auto_approved' | 'auto_cancelled' {
  return rule === 'auto_approve_customer_evidence' ? 'auto_approved' : 'auto_cancelled';
}
