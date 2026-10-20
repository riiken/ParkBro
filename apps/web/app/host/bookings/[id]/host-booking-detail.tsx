'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BookingDisputes } from '../../../../components/booking-disputes';
import { BookingReview } from '../../../../components/booking-review';
import { ChargingPanel } from '../../../../components/charging-panel';
import { CustomerTrust } from '../../../../components/customer-trust';
import { ISSUE_LABEL } from '../../../../components/get-in';
import { FormError } from '../../../../components/field';
import { HostGate } from '../../../../components/host-gate';
import { STATUS_LABEL, formatRupees, formatTime, formatWhen } from '../../../../lib/booking';
import { MODE_LABEL, VEHICLE_LABEL } from '../../../../lib/format';
import type { HostBooking } from '../../../../lib/host';

/**
 * H-07 booking detail: customer first name and initial, plate, times, space. Never the customer's phone or
 * contact details (trust-and-safety §11). Host cancellation refunds the customer in full and needs a reason.
 */
export function HostBookingDetail({ id }: { id: string }) {
  return <HostGate>{() => <Detail id={id} />}</HostGate>;
}

function Detail({ id }: { id: string }) {
  const [b, setB] = useState<HostBooking | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      setB(await apiRequest<HostBooking>(`/api/v1/host/bookings/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return setNotFound(true);
      setError(e instanceof ApiError ? e.userMessage : 'Could not load this booking.');
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body: object = {}) {
    setBusy(true);
    setError(null);
    try {
      setB(
        await apiRequest<HostBooking>(`/api/v1/host/bookings/${encodeURIComponent(id)}/${path}`, {
          method: 'POST',
          body,
        }),
      );
      setCancelling(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not update the booking.');
    } finally {
      setBusy(false);
    }
  }

  function onCancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void act('cancel', { reason: String(new FormData(e.currentTarget).get('reason') ?? '') });
  }

  if (notFound)
    return (
      <p>
        We couldn&apos;t find that booking. <Link href="/host/bookings">Bookings</Link>
      </p>
    );
  if (!b) return error ? <FormError message={error} /> : <p aria-busy="true">Loading booking…</p>;
  return (
    <div>
      <p>
        <Link href="/host/bookings">← Bookings</Link>
      </p>
      <h1>
        {b.customer.name} · {b.listing.title}
      </h1>
      <p>
        <span className={`status status-${b.status.toLowerCase()}`}>
          {STATUS_LABEL[b.status] ?? b.status}
        </span>
      </p>
      <ul className="facts">
        <li>
          {formatWhen(b.start, b.end)} · {MODE_LABEL[b.mode] ?? b.mode}
        </li>
        {b.unitLabel ? <li>Space {b.unitLabel}</li> : null}
        {b.vehicle ? (
          <li>
            {b.vehicle.plate} · {VEHICLE_LABEL[b.vehicle.vehicleClass] ?? b.vehicle.vehicleClass}
            {b.vehicle.isEv ? ' · EV' : ''}
          </li>
        ) : null}
        <li>
          Booking total {formatRupees(b.totalPaise)}. <Link href="/host/earnings">See your earnings</Link>
        </li>
        {b.series ? (
          <li>
            Month {b.series.periodIndex} of a monthly plan.{' '}
            <Link href={`/host/plans/${b.series.id}`}>View plan</Link>
          </li>
        ) : null}
      </ul>

      {['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(b.status) && b.mode === 'CHARGING_SESSION' ? (
        <ChargingPanel bookingId={b.id} host />
      ) : null}

      {['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'].includes(b.status) ? (
        <CustomerTrust bookingId={b.id} />
      ) : null}
      {b.status === 'COMPLETED' ? <BookingReview bookingId={b.id} as="HOST" /> : null}
      {['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(b.status) ? (
        <BookingDisputes bookingId={b.id} />
      ) : null}

      {b.issue?.status === 'OPEN' ? (
        <div className="notice issue" role="alert">
          <p>
            <strong>The customer can&apos;t get in:</strong> {ISSUE_LABEL[b.issue.kind] ?? b.issue.kind}
            {b.issue.note ? ` (“${b.issue.note}”)` : ''}. Fix it by {formatTime(b.issue.deadlineAt)}, or the
            customer is refunded in full automatically.
          </p>
          <div className="row-start">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(`issues/${b.issue?.id}/resolve`, { note: null })}
            >
              Fixed on site
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void act(`issues/${b.issue?.id}/escalate`, { note: null })}
            >
              Ask support to help
            </button>
          </div>
        </div>
      ) : null}
      {b.canReportNoShow ? (
        <p>
          The customer hasn&apos;t arrived.{' '}
          <button type="button" className="link" disabled={busy} onClick={() => void act('no-show')}>
            Report no-show (frees the space)
          </button>
        </p>
      ) : null}

      {b.status === 'AWAITING_HOST_APPROVAL' ? (
        <div className="notice">
          <p>
            New request{b.approvalExpiresAt ? `: respond by ${formatTime(b.approvalExpiresAt)}` : ''}. If you
            approve, the customer has 10 minutes to pay.
          </p>
          <div className="row-start">
            <button type="button" disabled={busy} onClick={() => void act('approve')}>
              Approve
            </button>
            <button type="button" className="link" disabled={busy} onClick={() => void act('decline')}>
              Decline
            </button>
          </div>
        </div>
      ) : null}
      {b.status === 'PENDING_PAYMENT' ? (
        <p className="notice">Approved. Waiting for the customer to pay.</p>
      ) : null}
      {b.status === 'CANCELLED' ? (
        <p className="notice">
          Cancelled by{' '}
          {b.cancelledBy === 'HOST' ? 'you' : b.cancelledBy === 'CUSTOMER' ? 'the customer' : 'ParkBro'}.
        </p>
      ) : null}

      <FormError message={error} />
      {['CONFIRMED', 'PENDING_PAYMENT'].includes(b.status) ? (
        cancelling ? (
          <form onSubmit={onCancel} noValidate className="notice" aria-label="Cancel booking">
            <p>
              The customer gets a full refund{b.series ? ' and the monthly plan ends' : ''}. Cancellations
              count against your reliability.
            </p>
            <div className="field">
              <label htmlFor="reason">Reason (the customer sees it)</label>
              <input id="reason" name="reason" minLength={5} maxLength={300} required />
            </div>
            <div className="row-start">
              <button type="submit" disabled={busy}>
                {busy ? 'Cancelling…' : 'Cancel booking'}
              </button>
              <button type="button" className="link" onClick={() => setCancelling(false)}>
                Keep booking
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="secondary" onClick={() => setCancelling(true)}>
            Cancel this booking
          </button>
        )
      ) : null}
    </div>
  );
}
