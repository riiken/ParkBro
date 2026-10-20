'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '../../components/field';
import {
  PLAN_STATUS_LABEL,
  STATUS_LABEL,
  formatDate,
  formatRupees,
  formatWhen,
  type BookingView,
  type PlanView,
} from '../../lib/booking';

const UPCOMING = new Set(['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS']);

/** Bookings (ux-architecture C-09): upcoming first, then past. */
export function BookingsList() {
  const router = useRouter();
  const [bookings, setBookings] = useState<BookingView[] | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, series] = await Promise.all([
        apiRequest<BookingView[]>('/api/v1/bookings'),
        apiRequest<PlanView[]>('/api/v1/series'),
      ]);
      setBookings(list);
      setPlans(series);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return router.replace('/sign-in?next=/bookings');
      setError(e instanceof ApiError ? e.userMessage : 'Could not load your bookings.');
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div>
        <FormError message={error} />
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!bookings) return <p aria-busy="true">Loading your bookings…</p>;
  if (bookings.length === 0) {
    return (
      <div className="empty">
        <p>No bookings yet.</p>
        <Link className="button" href="/search">
          Find parking
        </Link>
      </div>
    );
  }
  // Monthly periods live under their plan (C-15); the list shows the plan, not every month.
  const single = bookings.filter((b) => !b.series);
  const upcoming = single.filter((b) => UPCOMING.has(b.status)).reverse();
  const past = single.filter((b) => !UPCOMING.has(b.status));
  return (
    <>
      {plans.length ? (
        <section>
          <h2>Monthly plans</h2>
          <ul className="list">
            {plans.map((p) => (
              <li key={p.id}>
                <span>
                  <Link href={`/bookings/plans/${p.id}`}>{p.listing.title}</Link>
                  <br />
                  <span className="muted small">
                    From {formatDate(p.anchorStart)} · {formatRupees(p.periodPricePaise)}/month
                  </span>
                </span>
                <span className={`status status-${p.status.toLowerCase()}`}>
                  {PLAN_STATUS_LABEL[p.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {[
        ['Upcoming', upcoming],
        ['Past', past],
      ].map(([title, list]) =>
        (list as BookingView[]).length ? (
          <section key={title as string}>
            <h2>{title as string}</h2>
            <ul className="list">
              {(list as BookingView[]).map((b) => (
                <li key={b.id}>
                  <span>
                    <Link href={`/bookings/${b.id}`}>{b.listing.title}</Link>
                    <br />
                    <span className="muted small">{formatWhen(b.start, b.end)}</span>
                  </span>
                  <span className="small">
                    <span className={`status status-${b.status.toLowerCase()}`}>
                      {STATUS_LABEL[b.status] ?? b.status}
                    </span>
                    <br />
                    {formatRupees(b.price.totalPaise)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </>
  );
}
