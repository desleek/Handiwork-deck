/**
 * Removes phone numbers, emails, WhatsApp/Telegram links and social handles
 * from chat text so parties can't take the job off-platform before a quote
 * is approved.
 */
const PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, // emails
  /\b(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|t\.me|telegram\.me)\/\S*/gi,
  /(?:\+|00)?\d[\d\s().-]{6,}\d/g, // phone-like digit runs (8+ digits with separators)
  /(?:^|\s)@[A-Za-z0-9_.]{3,}/g, // @handles
];

export const CONTACT_REDACTION = '[contact hidden]';

export function maskContactInfo(text: string): { text: string; masked: boolean } {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (m) => {
      // Keep leading whitespace for @handle matches.
      const lead = /^\s/.test(m) ? m[0] : '';
      // Don't treat short numbers (prices, quantities) as phone numbers.
      if (/^[\d\s().+-]+$/.test(m.trim()) && m.replace(/\D/g, '').length < 8) return m;
      return `${lead}${CONTACT_REDACTION}`;
    });
  }
  return { text: out, masked: out !== text };
}
