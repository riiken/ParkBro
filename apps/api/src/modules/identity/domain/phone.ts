/**
 * India-first mobile numbers (D-004): +91 followed by 10 digits starting 6–9.
 * Accepts common user input forms (spaces, dashes, leading 0, 91, +91) and returns E.164, or null.
 */
export function normalizeIndianMobile(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, '');
  const match = /^(?:\+91|0091|91|0)?([6-9]\d{9})$/.exec(compact);
  return match ? `+91${match[1]}` : null;
}

export function maskPhone(last4: string): string {
  return `+91 ••••••${last4}`;
}
