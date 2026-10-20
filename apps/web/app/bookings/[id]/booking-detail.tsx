'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BookingDisputes } from '../../../components/booking-disputes';
import { BookingReview } from '../../../components/booking-review';
import { ChargingPanel } from '../../../components/charging-panel';
import { GetIn, type Issue } from '../../../components/get-in';
import { PayPanel } from '../../../components/pay-panel';
import { FormError } from '../../../components/field';
import { STATUS_LABEL, formatRupees, formatTime, formatWhen, type BookingView } from '../../../lib/booking';
import { MODE_LABEL } from '../../../lib/format';

/** Booking detail (ux-architecture C-08): status, what happens next, access once confirmed (L-6), cancel. */
export function BookingDetail({ id }: { id: string }) {
  const router = useRouter();
  const [booking, setBooking] = useState<BookingView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setBooking(await apiRequest<BookingView>(`/api/v1/bookings/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        return router.replace(`/sign-in?next=/bookings/${encodeURIComponent(id)}`);
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return setNotFound(true);
      setError(e instanceof ApiError ? e.userMessage : 'Could not load this booking.');
    }
  }, [id, router]);
  useEffect(() => {
    void load();
  }, [load]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      setBooking(
        await apiRequest<BookingView>(`/api/v1/bookings/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: {},
        }),
      );
      setConfirmingCancel(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not cancel.');
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <div className="empty">
        <p>We couldn&apos;t find that booking.</p>
        <Link href="/bookings">Your bookings</Link>
      </div>
    );
  }
  if (!booking) {
    return error ? (
      <div>
        <FormError message={error} />
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    ) : (
      <p aria-busy="true">Loading booking…</p>
    );
  }

  const b = booking;
  const refund = b.cancellation.refundIfCancelledNowPaise;
  return (
    <div>
      <p>
        <Link href="/bookings">← Your bookings</Link>
      </p>
      <h1>{b.listing.title}</h1>
      <p>
        <span className={`status status-${b.status.toLowerCase()}`}>
          {STATUS_LABEL[b.status] ?? b.status}
        </span>
      </p>
      <p>
        {formatWhen(b.start, b.end)} · {MODE_LABEL[b.mode] ?? b.mode}
        {b.vehicle ? ` · ${b.vehicle.plate}` : ''}
      </p>

      {b.status === 'PENDING_PAYMENT' && b.holdExpiresAt ? (
        <>
          <p className="small muted" role="status">
            We&apos;re holding this space for you until {formatTime(b.holdExpiresAt)}.
          </p>
          <PayPanel bookingId={b.id} amountPaise={b.price.totalPaise} onConfirmed={() => void load()} />
        </>
      ) : null}
      {b.status === 'AWAITING_HOST_APPROVAL' && b.approvalExpiresAt ? (
        <p className="notice" role="status">
          Request sent. The host has until {formatTime(b.approvalExpiresAt)} to respond. You won&apos;t be
          charged unless they accept and you pay.
        </p>
      ) : null}
      {b.status === 'EXPIRED' ? <p className="notice">This hold lapsed. Nothing was charged.</p> : null}
      {b.status === 'DECLINED' ? (
        <p className="notice">The host couldn&apos;t take this booking. Nothing was charged.</p>
      ) : null}

      {b.access ? (
        <section aria-labelledby="access-heading" className="notice">
          <h2 id="access-heading">Where to go</h2>
          {b.access.address ? <p>{b.access.address}</p> : null}
          {b.access.unitLabel ? <p>Space: {b.access.unitLabel}</p> : null}
          {b.access.instructions ? <p>{b.access.instructions}</p> : null}
        </section>
      ) : ['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'].includes(b.status) ? (
        <p className="small muted">
          The exact address and entry details appear here once the booking is confirmed.
        </p>
      ) : null}

      {['CONFIRMED', 'IN_PROGRESS'].includes(b.status) || (b.status === 'CANCELLED' && b.issue) ? (
        <GetIn
          bookingId={b.id}
          bookingStatus={b.status}
          issue={(b.issue as Issue | null) ?? null}
          onChange={() => void load()}
        />
      ) : null}
      {b.status === 'CANCELLED' && b.issue?.status === 'REFUNDED' ? (
        <p className="notice">
          The problem wasn&apos;t fixed in time, so we cancelled the booking and refunded you in full.{' '}
          <a href="/search">Find another space</a>
        </p>
      ) : null}

      {b.listing.type === 'EV_CHARGING' && ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(b.status) ? (
        <ChargingPanel bookingId={b.id} />
      ) : null}

      <h2>Price</h2>
      <table className="prices">
        <tbody>
          {b.price.lines.map((l) => (
            <tr key={l.label}>
              <th scope="row">{l.label}</th>
              <td>{formatRupees(l.amountPaise)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">
              <strong>Total</strong>
            </th>
            <td>{formatRupees(b.price.totalPaise)}</td>
          </tr>
        </tbody>
      </table>

      {b.status === 'CANCELLED' ? (
        <p>
          Cancelled by{' '}
          {b.cancellation.cancelledBy === 'CUSTOMER'
            ? 'you'
            : b.cancellation.cancelledBy === 'HOST'
              ? 'the host'
              : 'ParkBro'}
          .{b.cancellation.refundPaise ? ` Refund: ${formatRupees(b.cancellation.refundPaise)}.` : ''}
        </p>
      ) : null}

      {b.status === 'COMPLETED' ? <BookingReview bookingId={b.id} as="CUSTOMER" /> : null}
      {['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(b.status) ? (
        <BookingDisputes bookingId={b.id} />
      ) : null}

      <FormError message={error} />
      {b.series ? (
        <p className="small">
          Month {b.series.periodIndex} of a monthly plan.{' '}
          <Link href={`/bookings/plans/${b.series.id}`}>View plan</Link>
        </p>
      ) : null}
      {b.cancellation.cancellable ? (
        confirmingCancel ? (
          <div className="notice" role="alertdialog" aria-labelledby="cancel-q">
            <p id="cancel-q">
              Cancel this booking?{' '}
              {refund !== null && refund > 0
                ? `You'll be refunded ${formatRupees(refund)}.`
                : b.status === 'CONFIRMED'
                  ? 'No refund applies now.'
                  : 'Nothing has been charged.'}
            </p>
            <div className="row-start">
              <button type="button" disabled={busy} onClick={() => void cancel()}>
                {busy ? 'Cancelling…' : 'Yes, cancel'}
              </button>
              <button type="button" className="link" onClick={() => setConfirmingCancel(false)}>
                Keep booking
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirmingCancel(true)}>
            Cancel booking
          </button>
        )
      ) : null}
    </div>
  );
}
