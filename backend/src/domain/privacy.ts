/**
 * Masked communication (Section 8): before a job is approved, phone numbers, emails and
 * "call me"-style handles are stripped from chat so contact details can't leak around the platform.
 */

// Nigerian (+234 / 0xxx) and generic international numbers, tolerant of spaces, dots and dashes.
const PHONE = /(?:\+?\d[\s.\-()]*){10,15}/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Digits spelled out to dodge filters: "zero eight zero three..."
const SPELLED = /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,.-]*){7,}/gi;

export function redactContactDetails(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const mark = () => {
    redacted = true;
    return '[hidden until booking is confirmed]';
  };
  const out = text.replace(EMAIL, mark).replace(SPELLED, mark).replace(PHONE, mark);
  return { text: out, redacted };
}

/** Contacts are released only once the job is approved/confirmed (Section 8). */
export const CONTACT_RELEASE_STATUSES = new Set([
  'funded',
  'en_route',
  'in_progress',
  'awaiting_confirmation',
  'completed',
]);

export function shouldRedact(jobStatus: string): boolean {
  return !CONTACT_RELEASE_STATUSES.has(jobStatus);
}
