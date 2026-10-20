'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  PLAN_END_LABEL,
  PLAN_STATUS_LABEL,
  STATUS_LABEL,
  formatDate,
  formatRupees,
  type PlanView,
} from '../lib/booking';
import { FormError } from './field';

/**
 * Monthly plan (C-15 customer, H-11 host): periods, next renewal, notice. Notice ends the plan at a period
 * boundary at least `noticeDays` away (domain-model §5.4); the server computes it.
 */
export function PlanDetail({ id, as }: { id: string; as: 'CUSTOMER' | 'HOST' }) {
  const router = useRouter();
  const base = as === 'HOST' ? '/api/v1/host/series' : '/api/v1/series';
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setPlan(await apiRequest<PlanView>(`${base}/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        return router.replace(`/sign-in?next=${encodeURIComponent(location.pathname)}`);
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return setNotFound(true);
      setError(e instanceof ApiError ? e.userMessage : 'Could not load this plan.');
    }
  }, [base, id, router]);
  useEffect(() => {
    void load();
  }, [load]);

  async function giveNotice() {
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await apiRequest<PlanView>(`${base}/${encodeURIComponent(id)}/notice`, { method: 'POST', body: {} }),
      );
      setConfirming(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not give notice.');
    } finally {
      setBusy(false);
    }
  }

  const back =
    as === 'HOST'
      ? { href: '/host/plans', label: '← Monthly plans' }
      : { href: '/bookings', label: '← Your bookings' };
  if (notFound) {
    return (
      <div className="empty">
        <p>We couldn&apos;t find that plan.</p>
        <Link href={back.href}>{back.label.slice(2)}</Link>
      </div>
    );
  }
  if (!plan) {
    return error ? (
      <div>
        <FormError message={error} />
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    ) : (
      <p aria-busy="true">Loading plan…</p>
    );
  }

  const p = plan;
  const bookingHref = (bookingId: string) =>
    as === 'HOST' ? `/host/bookings/${bookingId}` : `/bookings/${bookingId}`;
  const unpaid = p.periods.find((x) => x.status === 'PENDING_PAYMENT' && x.payBy);
  return (
    <div>
      <p>
        <Link href={back.href}>{back.label}</Link>
      </p>
      <h1>{p.listing.title}</h1>
      <p>
        <span className={`status status-${p.status.toLowerCase()}`}>{PLAN_STATUS_LABEL[p.status]}</span>
      </p>
      <p>
        Monthly from {formatDate(p.anchorStart)} · {formatRupees(p.periodPricePaise)} a month
        {p.vehicle ? ` · ${p.vehicle.plate}` : ''}
        {as === 'HOST' && p.customer ? ` · ${p.customer.name}` : ''}
        {as === 'HOST' && p.unitLabel ? ` · Space ${p.unitLabel}` : ''}
      </p>

      {p.status === 'REQUESTED' ? (
        <p className="notice" role="status">
          {as === 'HOST'
            ? 'New monthly request. Respond from the booking for month 1.'
            : 'Request sent. The host reviews monthly requests before you pay.'}
        </p>
      ) : null}
      {p.status === 'PAST_DUE' && unpaid?.payBy ? (
        <p className="notice" role="alert">
          {as === 'HOST'
            ? `Renewal not paid yet. The space is held until ${formatDate(unpaid.payBy)}.`
            : `Renewal payment is due. Pay by ${formatDate(unpaid.payBy)} to keep your spot.`}
        </p>
      ) : null}
      {p.status === 'NOTICE_GIVEN' && p.endsAt ? (
        <p className="notice" role="status">
          Ending {formatDate(p.endsAt)} (notice given by{' '}
          {p.noticeBy === (as === 'HOST' ? 'HOST' : 'CUSTOMER')
            ? 'you'
            : p.noticeBy === 'PLATFORM'
              ? 'ParkBro'
              : as === 'HOST'
                ? 'the customer'
                : 'the host'}
          ).
        </p>
      ) : null}
      {p.status === 'ENDED' ? (
        <p className="notice">{PLAN_END_LABEL[p.endedReason ?? ''] ?? 'Ended.'}</p>
      ) : null}
      {p.nextRenewal && p.status === 'ACTIVE' ? (
        <p>
          Next month starts {formatDate(p.nextRenewal.start)} for {formatRupees(p.nextRenewal.amountPaise)}.
          The space is held for you {p.graceDays} days after that while payment completes.
        </p>
      ) : null}

      <h2>Months</h2>
      <ul className="list">
        {p.periods.map((x) => (
          <li key={x.bookingId}>
            <span>
              <Link href={bookingHref(x.bookingId)}>Month {x.index}</Link>
              <br />
              <span className="muted small">
                {formatDate(x.start)} – {formatDate(x.end)}
              </span>
            </span>
            <span className="small">
              <span className={`status status-${x.status.toLowerCase()}`}>
                {STATUS_LABEL[x.status] ?? x.status}
              </span>
              <br />
              {formatRupees(x.amountPaise)}
            </span>
          </li>
        ))}
      </ul>

      <FormError message={error} />
      {p.status === 'ACTIVE' || p.status === 'PAST_DUE' ? (
        confirming ? (
          <div className="notice" role="alertdialog" aria-labelledby="notice-q">
            <p id="notice-q">
              Give notice? The plan ends at the end of the first monthly period at least {p.noticeDays} days
              from now. Any later month already reserved is released
              {as === 'CUSTOMER' ? ' and refunded if paid' : ' and refunded in full'}.
            </p>
            <div className="row-start">
              <button type="button" disabled={busy} onClick={() => void giveNotice()}>
                {busy ? 'Sending…' : 'Yes, give notice'}
              </button>
              <button type="button" className="link" onClick={() => setConfirming(false)}>
                Keep plan
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setConfirming(true)}>
            Give notice
          </button>
        )
      ) : null}
    </div>
  );
}
