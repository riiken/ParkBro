/**
 * Detects contact details in public, user-written text (listing titles, descriptions, rules, later reviews and
 * pre-booking messages). Off-platform contact leaks undermine trust, safety and recourse (trust-and-safety §5, R-04).
 * Deliberately conservative: blocks obvious phone numbers, emails, URLs, UPI IDs and messaging-app handles.
 */
const PATTERNS: { kind: string; pattern: RegExp }[] = [
  // Indian mobile numbers with optional +91/0 and separators, or any long digit run.
  { kind: 'phone', pattern: /(?:\+?91[\s-]*|0)?[6-9](?:[\s-]*\d){9}\b/ },
  { kind: 'phone', pattern: /\d(?:[\s-]*\d){9,}/ },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'upi', pattern: /\b[A-Za-z0-9._-]{2,}@(?:ok)?[A-Za-z]{2,}\b/ },
  {
    kind: 'url',
    pattern: /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|me|app|link)\b/i,
  },
  { kind: 'messaging', pattern: /\b(?:whats\s*app|wa\.me|telegram|t\.me|signal)\b/i },
];

export function findContactDetails(text: string): string | null {
  for (const { kind, pattern } of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

export const CONTACT_DETAILS_MESSAGE =
  "Don't include phone numbers, emails, links or messaging handles. Customers contact you through ParkBro.";
