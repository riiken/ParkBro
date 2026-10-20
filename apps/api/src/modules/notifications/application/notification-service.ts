import { sql, type Kysely, type Selectable } from 'kysely';
import type { AnyKyselyExecutor } from '../../../platform/audit/audit-log.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { AssetsModule } from '../../assets/index.ts';
import type { BookingModule } from '../../booking/index.ts';
import type { IdentityModule } from '../../identity/index.ts';
import { PermanentDeliveryError, type ExternalChannel, type MessagingProvider } from '../domain/provider.ts';
import {
  channelsFor,
  MAX_ATTEMPTS,
  render,
  RETRY_MINUTES,
  TEMPLATES,
  type TemplateKey,
} from '../domain/templates.ts';
import type { NotificationsDb, NotificationsTable } from '../infrastructure/tables.ts';

type Row = Selectable<NotificationsTable>;
const SENDING_LEASE_MINUTES = 10;
const TZ = 'Asia/Kolkata'; // pilot city (D-079); per-user timezone when there is more than one city
const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
const fmtTime = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

interface Vars {
  bookingId?: string;
  at?: number;
  amountPaise?: number;
  energyKwh?: number | null;
}

/**
 * Notifications (Phase 18). Rows are written in the transaction of the event that causes them (outbox), one per
 * recipient and channel with an event-derived dedupe key, so an event can never notify twice. A worker delivers
 * external channels with retries and backoff; providers report delivery by signed webhook.
 */
export function createNotificationService(deps: {
  db: Kysely<NotificationsDb>;
  events: DomainEventBus;
  identity: Pick<IdentityModule, 'contactFor' | 'hostMemberIds'>;
  booking: Pick<BookingModule, 'partiesOf' | 'scheduleFeed'>;
  assets: Pick<AssetsModule, 'bookingContext'>;
  provider: MessagingProvider | null;
  now?: () => number;
}) {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const x = (executor?: AnyKyselyExecutor) =>
    (executor as unknown as Kysely<NotificationsDb> | undefined) ?? db;

  /** Outbox write: in-app is delivered by being written; external channels wait for the worker. */
  async function enqueue(
    executor: AnyKyselyExecutor | undefined,
    input: { userIds: string[]; template: TemplateKey; eventKey: string; vars?: Vars; link?: string },
  ) {
    const { category } = TEMPLATES[input.template];
    for (const userId of [...new Set(input.userIds)]) {
      const prefs = await x(executor)
        .selectFrom('notifications.preferences')
        .select(['channel', 'enabled'])
        .where('user_id', '=', userId)
        .execute();
      const channels = channelsFor(category, Object.fromEntries(prefs.map((p) => [p.channel, p.enabled])), {
        messaging: !!provider,
        email: false,
        push: false,
      });
      for (const channel of channels) {
        const inApp = channel === 'IN_APP';
        await x(executor)
          .insertInto('notifications.notifications')
          .values({
            id: uuidv7(),
            user_id: userId,
            template: input.template,
            category,
            channel,
            vars: JSON.stringify(input.vars ?? {}),
            link: input.link ?? null,
            dedupe_key: `${input.eventKey}:${userId}:${channel}`,
            status: inApp ? 'SENT' : 'PENDING',
            ...(inApp ? { sent_at: new Date(now()), provider: 'in-app' } : {}),
          })
          .onConflict((oc) => oc.column('dedupe_key').doNothing())
          .execute();
      }
    }
  }

  const parties = (bookingId: string, executor?: AnyKyselyExecutor) =>
    deps.booking.partiesOf(bookingId, executor);
  const hostUsers = (hostAccountId: string, executor?: AnyKyselyExecutor) =>
    deps.identity.hostMemberIds(hostAccountId, executor);
  const bookingLink = (id: string) => `/bookings/${id}`;
  const hostBookingLink = (id: string) => `/host/bookings/${id}`;

  // ---------------------------------------------------------------- event → notification (in the event's transaction)

  deps.events.subscribe('booking.requested', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: await hostUsers(p.hostAccountId, ex),
      template: 'booking.requested.host',
      eventKey: `booking:${p.bookingId}:requested`,
      vars: { bookingId: p.bookingId, at: p.start },
      link: hostBookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('booking.approved', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: [p.customerId],
      template: 'booking.approved.customer',
      eventKey: `booking:${p.bookingId}:approved`,
      vars: { bookingId: p.bookingId },
      link: bookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('booking.confirmed', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    const vars = { bookingId: p.bookingId, at: p.start };
    await enqueue(ex, {
      userIds: [p.customerId],
      template: 'booking.confirmed.customer',
      eventKey: `booking:${p.bookingId}:confirmed`,
      vars,
      link: bookingLink(p.bookingId),
    });
    await enqueue(ex, {
      userIds: await hostUsers(p.hostAccountId, ex),
      template: 'booking.confirmed.host',
      eventKey: `booking:${p.bookingId}:confirmed:host`,
      vars,
      link: hostBookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('booking.closed', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    if (e.status === 'CANCELLED') {
      const vars = {
        bookingId: p.bookingId,
        at: p.start,
        ...(p.refundPaise ? { amountPaise: p.refundPaise } : {}),
      };
      await enqueue(ex, {
        userIds: [p.customerId],
        template: 'booking.cancelled.customer',
        eventKey: `booking:${p.bookingId}:cancelled`,
        vars,
        link: bookingLink(p.bookingId),
      });
      await enqueue(ex, {
        userIds: await hostUsers(p.hostAccountId, ex),
        template: 'booking.cancelled.host',
        eventKey: `booking:${p.bookingId}:cancelled:host`,
        vars,
        link: hostBookingLink(p.bookingId),
      });
    } else if (e.status === 'DECLINED') {
      await enqueue(ex, {
        userIds: [p.customerId],
        template: 'booking.declined.customer',
        eventKey: `booking:${p.bookingId}:declined`,
        vars: { bookingId: p.bookingId },
        link: '/search',
      });
    } else if (e.status === 'NO_SHOW') {
      await enqueue(ex, {
        userIds: [p.customerId],
        template: 'booking.no_show.customer',
        eventKey: `booking:${p.bookingId}:no_show`,
        vars: { bookingId: p.bookingId },
        link: bookingLink(p.bookingId),
      });
    }
  });
  deps.events.subscribe('booking.issue_opened', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: await hostUsers(p.hostAccountId, ex),
      template: 'issue.opened.host',
      eventKey: `issue:${e.issueId}:opened`,
      vars: { bookingId: p.bookingId, at: e.deadlineAt.getTime() },
      link: hostBookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('payment.captured', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: [p.customerId],
      template: 'payment.received.customer',
      eventKey: `payment:${e.paymentId}:captured`,
      vars: { bookingId: p.bookingId, amountPaise: e.amountPaise },
      link: bookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('payment.failed', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: [p.customerId],
      template: 'payment.failed.customer',
      eventKey: `payment:${e.paymentId}:failed`,
      vars: { bookingId: p.bookingId },
      link: bookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('payment.refund_recorded', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: [p.customerId],
      template: 'refund.started.customer',
      eventKey: `refund:${e.refundId}:started`,
      vars: { bookingId: p.bookingId, amountPaise: e.amountPaise },
      link: bookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('payment.refund_succeeded', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: [p.customerId],
      template: 'refund.completed.customer',
      eventKey: `refund:${e.refundId}:completed`,
      vars: { bookingId: p.bookingId, amountPaise: e.amountPaise },
      link: bookingLink(p.bookingId),
    });
  });
  deps.events.subscribe('charging.started', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    await enqueue(ex, {
      userIds: [e.customerId],
      template: 'charging.started.customer',
      eventKey: `charging:${e.bookingId}:started`,
      vars: { bookingId: e.bookingId, at: p.end },
      link: bookingLink(e.bookingId),
    });
  });
  deps.events.subscribe('charging.completed', async (e, ex) => {
    await enqueue(ex, {
      userIds: [e.customerId],
      template: 'charging.completed.customer',
      eventKey: `charging:${e.bookingId}:completed`,
      vars: { bookingId: e.bookingId, energyKwh: e.energyKwh },
      link: bookingLink(e.bookingId),
    });
  });
  deps.events.subscribe('payout.settled', async (e, ex) => {
    await enqueue(ex, {
      userIds: await hostUsers(e.hostAccountId, ex),
      template: e.status === 'PAID' ? 'payout.paid.host' : 'payout.failed.host',
      eventKey: `payout:${e.payoutId}:${e.status.toLowerCase()}`,
      vars: { amountPaise: e.amountPaise },
      link: '/host/earnings',
    });
  });
  deps.events.subscribe('payout_account.reviewed', async (e, ex) => {
    await enqueue(ex, {
      userIds: await hostUsers(e.hostAccountId, ex),
      template: e.decision === 'VERIFIED' ? 'payout_account.verified.host' : 'payout_account.rejected.host',
      eventKey: `payout_account:${e.accountId}:${e.decision.toLowerCase()}`,
      link: '/host/earnings',
    });
  });

  deps.events.subscribe('dispute.updated', async (e, ex) => {
    const p = await parties(e.bookingId, ex);
    if (!p) return;
    const users = [
      ...(e.notify.includes('CUSTOMER') ? [p.customerId] : []),
      ...(e.notify.includes('HOST') ? await hostUsers(p.hostAccountId, ex) : []),
    ];
    // One message per dispute update and recipient (dedupe by a time bucket so a burst of messages notifies once a minute).
    const bucket = Math.floor(now() / 60_000);
    await enqueue(ex, {
      userIds: users,
      template: 'dispute.update',
      eventKey: `dispute:${e.disputeId}:${bucket}`,
      vars: { bookingId: p.bookingId },
      link: `/disputes/${e.disputeId}`,
    });
  });

  // ---------------------------------------------------------------- time-based (job)

  /** Reminder (≤ 60 min before start, if booked more than 30 min ahead), access open (at start), ending soon. */
  async function schedule(): Promise<number> {
    const t = now();
    let n = 0;
    for (const b of await deps.booking.scheduleFeed()) {
      const p = await parties(b.bookingId);
      if (!p) continue;
      const send = async (template: TemplateKey, key: string, at: number) => {
        await db.transaction().execute((trx) =>
          enqueue(trx, {
            userIds: [p.customerId],
            template,
            eventKey: `booking:${b.bookingId}:${key}`,
            vars: { bookingId: b.bookingId, at },
            link: bookingLink(b.bookingId),
          }),
        );
        n += 1;
      };
      if (b.start > t && b.start - t <= 60 * 60_000 && b.start - b.createdAt.getTime() > 30 * 60_000)
        await send('booking.reminder.customer', 'reminder', b.start);
      if (t >= b.start && t < b.start + 15 * 60_000) await send('booking.started.customer', 'started', b.end);
      if (b.end > t && b.end - t <= 15 * 60_000 && b.end - b.start > 30 * 60_000)
        await send('booking.ending.customer', 'ending', b.end);
    }
    return n;
  }

  // ---------------------------------------------------------------- delivery (job)

  async function renderRow(row: Row) {
    const vars = (row.vars ?? {}) as Vars;
    let listingTitle = 'your booking';
    if (vars.bookingId) {
      const p = await parties(vars.bookingId);
      const ctx = p ? await deps.assets.bookingContext(p.assetId) : null;
      if (ctx) listingTitle = ctx.title;
    }
    return render(row.template as TemplateKey, {
      listingTitle,
      ...(vars.amountPaise !== undefined ? { amount: rupees.format(vars.amountPaise / 100) } : {}),
      ...(vars.energyKwh != null ? { amount: `${vars.energyKwh} kWh` } : {}),
      ...(vars.at
        ? { time: fmtTime.format(new Date(vars.at)), date: fmtDate.format(new Date(vars.at)) }
        : {}),
    });
  }

  async function deliver(): Promise<number> {
    if (!provider) {
      // No messaging provider configured: external messages are suppressed (in-app still works).
      await db
        .updateTable('notifications.notifications')
        .set({ status: 'SUPPRESSED', suppressed_reason: 'no messaging provider configured' })
        .where('status', '=', 'PENDING')
        .execute();
      return 0;
    }
    const batch = await db
      .updateTable('notifications.notifications')
      .set({ status: 'SENDING', claimed_at: new Date(now()) })
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('notifications.notifications')
          .select('id')
          .where((w) =>
            w.or([
              w.and([w('status', '=', 'PENDING'), w('next_attempt_at', '<=', new Date(now()))]),
              // A worker that crashed mid-send: retry after the lease (providers dedupe by our id).
              w.and([
                w('status', '=', 'SENDING'),
                w('claimed_at', '<', new Date(now() - SENDING_LEASE_MINUTES * 60_000)),
              ]),
            ]),
          )
          .orderBy('next_attempt_at')
          .limit(50)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .execute();
    let sent = 0;
    for (const row of batch) {
      const contact = await deps.identity.contactFor(row.user_id);
      const to = row.channel === 'EMAIL' ? contact?.email : contact?.phoneE164;
      if (!contact?.active || !to) {
        await db
          .updateTable('notifications.notifications')
          .set({
            status: 'SUPPRESSED',
            suppressed_reason: !contact?.active ? 'account not active' : 'no address for channel',
          })
          .where('id', '=', row.id)
          .execute();
        continue;
      }
      try {
        const msg = await renderRow(row);
        const res = await provider.send({
          channel: row.channel as ExternalChannel,
          to,
          template: row.template,
          text: msg.text,
          idempotencyKey: row.id,
        });
        await db
          .updateTable('notifications.notifications')
          .set({
            status: 'SENT',
            provider: provider.name,
            provider_message_id: res.messageId,
            sent_at: new Date(now()),
            attempts: sql<number>`attempts + 1`,
            last_error: null,
          })
          .where('id', '=', row.id)
          .execute();
        sent += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const permanent = error instanceof PermanentDeliveryError;
        const giveUp = permanent || attempts >= MAX_ATTEMPTS;
        await db
          .updateTable('notifications.notifications')
          .set({
            status: giveUp ? 'FAILED' : 'PENDING',
            attempts,
            last_error: String((error as Error).message).slice(0, 300),
            next_attempt_at: new Date(now() + (RETRY_MINUTES[attempts - 1] ?? 360) * 60_000),
          })
          .where('id', '=', row.id)
          .execute();
      }
    }
    return sent;
  }

  async function handleDeliveryWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    if (!provider || !provider.verifyWebhook(rawBody, headers)) throw errors.unauthenticated();
    let updated = 0;
    for (const s of provider.parseWebhook(rawBody)) {
      const res = await db
        .updateTable('notifications.notifications')
        .set(
          s.status === 'DELIVERED'
            ? { status: 'DELIVERED', delivered_at: new Date(now()) }
            : { status: 'FAILED', last_error: (s.error ?? 'provider reported failure').slice(0, 300) },
        )
        .where('provider', '=', provider.name)
        .where('provider_message_id', '=', s.messageId)
        .where('status', '=', 'SENT') // statuses only move forward; duplicates are no-ops
        .executeTakeFirst();
      updated += Number(res.numUpdatedRows);
    }
    return { updated };
  }

  // ---------------------------------------------------------------- inbox and preferences

  async function inbox(userId: string) {
    const rows = await db
      .selectFrom('notifications.notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .where('channel', '=', 'IN_APP')
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    const items = await Promise.all(
      rows.map(async (r) => {
        const m = await renderRow(r);
        return {
          id: r.id,
          title: m.title,
          body: m.body,
          link: r.link,
          category: r.category as 'CRITICAL' | 'TRANSACTIONAL' | 'REMINDER',
          read: r.read_at !== null,
          createdAt: r.created_at,
        };
      }),
    );
    const unread = await db
      .selectFrom('notifications.notifications')
      .select(sql<string>`count(*)`.as('n'))
      .where('user_id', '=', userId)
      .where('channel', '=', 'IN_APP')
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { items, unread: Number(unread.n) };
  }

  async function markRead(userId: string, ids: string[] | 'all') {
    let q = db
      .updateTable('notifications.notifications')
      .set({ read_at: new Date(now()), status: 'DELIVERED', delivered_at: new Date(now()) })
      .where('user_id', '=', userId)
      .where('channel', '=', 'IN_APP')
      .where('read_at', 'is', null);
    if (ids !== 'all') q = q.where('id', 'in', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    await q.execute();
  }

  async function preferences(userId: string) {
    const rows = await db
      .selectFrom('notifications.preferences')
      .select(['channel', 'enabled'])
      .where('user_id', '=', userId)
      .execute();
    const map = Object.fromEntries(rows.map((r) => [r.channel, r.enabled])) as Record<string, boolean>;
    return {
      whatsapp: map.WHATSAPP ?? true,
      sms: map.SMS ?? true,
      email: map.EMAIL ?? true,
      push: map.PUSH ?? true,
    };
  }

  async function setPreferences(
    userId: string,
    input: { [K in 'whatsapp' | 'sms' | 'email' | 'push']?: boolean | undefined },
  ) {
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      await db
        .insertInto('notifications.preferences')
        .values({ user_id: userId, channel: k.toUpperCase(), enabled: v })
        .onConflict((oc) =>
          oc.columns(['user_id', 'channel']).doUpdateSet({ enabled: v, updated_at: new Date(now()) }),
        )
        .execute();
    }
    return preferences(userId);
  }

  return { enqueue, schedule, deliver, handleDeliveryWebhook, inbox, markRead, preferences, setPreferences };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
