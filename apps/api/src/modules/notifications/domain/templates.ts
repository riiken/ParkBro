/**
 * Notification templates (ux-architecture §12; copy rules §7). Pure. Variables never include phone numbers, access
 * codes or exact addresses: links open the app, where access is re-authorised (L-6). SMS and WhatsApp send the same
 * text through DLT-registered / approved templates (ids configured per template when providers exist, R-46).
 */
export type Category = 'CRITICAL' | 'TRANSACTIONAL' | 'REMINDER';
export type Channel = 'IN_APP' | 'PUSH' | 'SMS' | 'WHATSAPP' | 'EMAIL';

export interface RenderContext {
  listingTitle: string;
  amount?: string;
  time?: string;
  date?: string;
}

interface Template {
  category: Category;
  title: (c: RenderContext) => string;
  body: (c: RenderContext) => string;
}

const T = (category: Category, title: Template['title'], body: Template['body']): Template => ({
  category,
  title,
  body,
});

export const TEMPLATES = {
  'booking.requested.host': T(
    'CRITICAL',
    () => 'New booking request',
    (c) => `Request for ${c.listingTitle} on ${c.date} at ${c.time}. Approve or decline in the app.`,
  ),
  'booking.approved.customer': T(
    'TRANSACTIONAL',
    () => 'Request approved',
    (c) => `The host approved ${c.listingTitle}. Pay within 10 minutes to confirm.`,
  ),
  'booking.declined.customer': T(
    'TRANSACTIONAL',
    () => 'Request declined',
    (c) => `The host couldn't take your request for ${c.listingTitle}. You weren't charged.`,
  ),
  'booking.confirmed.customer': T(
    'TRANSACTIONAL',
    () => 'Booking confirmed',
    (c) => `${c.listingTitle} on ${c.date} at ${c.time}. Your access details are in the app.`,
  ),
  'booking.confirmed.host': T(
    'TRANSACTIONAL',
    () => 'New booking',
    (c) => `${c.listingTitle} is booked for ${c.date} at ${c.time}.`,
  ),
  'booking.cancelled.customer': T(
    'TRANSACTIONAL',
    () => 'Booking cancelled',
    (c) =>
      `Your booking at ${c.listingTitle} on ${c.date} is cancelled.${c.amount ? ` Refund: ${c.amount}.` : ''}`,
  ),
  'booking.cancelled.host': T(
    'TRANSACTIONAL',
    () => 'Booking cancelled',
    (c) => `The booking at ${c.listingTitle} on ${c.date} at ${c.time} is cancelled.`,
  ),
  'booking.no_show.customer': T(
    'TRANSACTIONAL',
    () => 'Marked as no-show',
    (c) =>
      `The host reported you didn't arrive at ${c.listingTitle}. If that's wrong, open a dispute in the app.`,
  ),
  'booking.reminder.customer': T(
    'REMINDER',
    () => 'Starting soon',
    (c) => `${c.listingTitle} starts at ${c.time}. Your code and directions are in the app.`,
  ),
  'booking.started.customer': T(
    'REMINDER',
    () => 'Your spot is ready',
    (c) => `Access to ${c.listingTitle} is open now until ${c.time}.`,
  ),
  'booking.ending.customer': T(
    'REMINDER',
    () => 'Ending soon',
    (c) => `Your booking at ${c.listingTitle} ends at ${c.time}.`,
  ),
  'payment.received.customer': T(
    'TRANSACTIONAL',
    () => 'Payment received',
    (c) => `${c.amount} for ${c.listingTitle}.`,
  ),
  'payment.failed.customer': T(
    'TRANSACTIONAL',
    () => "Payment didn't go through",
    (c) => `Your payment for ${c.listingTitle} failed. No money was taken. Try again in the app.`,
  ),
  'refund.started.customer': T(
    'TRANSACTIONAL',
    () => 'Refund started',
    (c) => `${c.amount} for ${c.listingTitle}. It usually reaches you in 5–7 working days.`,
  ),
  'refund.completed.customer': T(
    'TRANSACTIONAL',
    () => 'Refund completed',
    (c) => `${c.amount} for ${c.listingTitle} has been refunded.`,
  ),
  'issue.opened.host': T(
    'CRITICAL',
    () => "Customer can't get in",
    (c) => `At ${c.listingTitle}. Fix it by ${c.time} or the customer is refunded in full.`,
  ),
  'charging.started.customer': T(
    'TRANSACTIONAL',
    () => 'Charging started',
    (c) => `At ${c.listingTitle}. Your booking ends at ${c.time}.`,
  ),
  'charging.completed.customer': T(
    'TRANSACTIONAL',
    () => 'Charging finished',
    (c) => `At ${c.listingTitle}.${c.amount ? ` ${c.amount} delivered.` : ''}`,
  ),
  'payout.paid.host': T(
    'TRANSACTIONAL',
    () => 'Payout sent',
    (c) => `${c.amount} has been sent to your account.`,
  ),
  'payout.failed.host': T(
    'TRANSACTIONAL',
    () => "Payout didn't go through",
    (c) => `${c.amount} is back in your balance. Check your payout details in the app.`,
  ),
  'payout_account.verified.host': T(
    'TRANSACTIONAL',
    () => 'Payout account verified',
    () => 'Your payout account is verified. Payouts go out weekly.',
  ),
  'payout_account.rejected.host': T(
    'TRANSACTIONAL',
    () => 'Payout account not verified',
    () => "We couldn't verify your payout account. Please add it again in the app.",
  ),
  'dispute.update': T(
    'TRANSACTIONAL',
    () => 'Dispute update',
    (c) => `There's an update on your dispute about ${c.listingTitle}.`,
  ),
} as const satisfies Record<string, Template>;

export type TemplateKey = keyof typeof TEMPLATES;

export function render(key: TemplateKey, ctx: RenderContext): { title: string; body: string; text: string } {
  const t = TEMPLATES[key];
  const title = t.title(ctx);
  const body = t.body(ctx);
  return { title, body, text: `ParkBro: ${title}. ${body}` };
}

/**
 * Channel policy (D-144): always in-app; plus one external channel. WhatsApp is preferred, SMS is the fallback;
 * CRITICAL messages ignore opt-outs (a host must hear that a customer is stuck at the gate). Email and push only
 * when the user has an address / subscription.
 */
export function channelsFor(
  category: Category,
  prefs: Partial<Record<'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH', boolean>>,
  available: { email: boolean; push: boolean; messaging: boolean },
): Channel[] {
  const on = (c: 'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH') => prefs[c] !== false;
  const out: Channel[] = ['IN_APP'];
  if (available.messaging) {
    if (on('WHATSAPP')) out.push('WHATSAPP');
    else if (on('SMS') || category === 'CRITICAL') out.push('SMS');
  }
  if (available.push && on('PUSH')) out.push('PUSH');
  if (available.email && on('EMAIL') && category !== 'REMINDER') out.push('EMAIL');
  return out;
}

/** Retry schedule (minutes after each failed attempt). After the last, the message is FAILED. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360] as const;
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
