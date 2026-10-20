'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '../../components/field';
import { HostGate } from '../../components/host-gate';
import { formatRupees, formatTime, formatWhen } from '../../lib/booking';
import {
  ASSET_STATUS_LABEL,
  type HostAccount,
  type HostAssetSummary,
  type HostBooking,
} from '../../lib/host';

/** H-01 Today: action cards in priority order (approvals with deadlines) → today's and tomorrow's arrivals. */
export function HostToday() {
  return <HostGate>{(account) => <Today account={account} />}</HostGate>;
}

function Today({ account }: { account: HostAccount }) {
  const [bookings, setBookings] = useState<HostBooking[] | null>(null);
  const [listings, setListings] = useState<HostAssetSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, l] = await Promise.all([
        apiRequest<HostBooking[]>('/api/v1/host/bookings'),
        apiRequest<HostAssetSummary[]>('/api/v1/host/assets'),
      ]);
      setBookings(b);
      setListings(l);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not load your hosting summary.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function respond(id: string, action: 'approve' | 'decline') {
    setBusyId(id);
    setError(null);
    try {
      await apiRequest(`/api/v1/host/bookings/${id}/${action}`, { method: 'POST', body: {} });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not update the request.');
    } finally {
      setBusyId(null);
    }
  }

  if (!bookings) {
    return error ? (
      <div>
        <FormError message={error} />
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    ) : (
      <p aria-busy="true">Loading…</p>
    );
  }

  const requests = bookings.filter((b) => b.status === 'AWAITING_HOST_APPROVAL');
  const problems = bookings.filter((b) => b.issue?.status === 'OPEN');
  const horizon = Date.now() + 48 * 3_600_000;
  const arrivals = bookings
    .filter((b) => ['CONFIRMED', 'IN_PROGRESS', 'PENDING_PAYMENT'].includes(b.status))
    .filter((b) => new Date(b.start).getTime() < horizon && new Date(b.end).getTime() > Date.now())
    .sort((a, b) => a.start.localeCompare(b.start));
  const drafts = listings.filter((l) => l.status === 'DRAFT');

  return (
    <div>
      <h1>Hi {account.displayName}</h1>
      {account.status !== 'ACTIVE' ? (
        <p className="notice" role="alert">
          Your host account is {account.status.toLowerCase()}. You can view your listings and bookings;
          contact support to make changes.
        </p>
      ) : null}
      <FormError message={error} />

      <ul className="stats" aria-label="At a glance">
        <li className={requests.length ? 'attention' : undefined}>
          <strong>{requests.length}</strong>
          <span>{requests.length === 1 ? 'request' : 'requests'} to answer</span>
        </li>
        <li>
          <strong>{arrivals.length}</strong>
          <span>arrivals in 48 h</span>
        </li>
        <li>
          <strong>{listings.filter((l) => l.status === 'PUBLISHED').length}</strong>
          <span>live listings</span>
        </li>
      </ul>

      {problems.length ? (
        <section aria-labelledby="problems-h" className="notice issue">
          <h2 id="problems-h">Customers who can&apos;t get in</h2>
          <ul className="list">
            {problems.map((b) => (
              <li key={b.id}>
                <Link href={`/host/bookings/${b.id}`}>
                  {b.customer.name} · {b.listing.title}
                </Link>
                <span className="small">fix by {b.issue ? formatTime(b.issue.deadlineAt) : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="requests-h">
        <h2 id="requests-h">Requests to respond to</h2>
        {requests.length === 0 ? (
          <p className="muted">No requests waiting.</p>
        ) : (
          <ul className="list">
            {requests.map((b) => (
              <li key={b.id}>
                <span>
                  <Link href={`/host/bookings/${b.id}`}>
                    {b.customer.name} · {b.listing.title}
                  </Link>
                  <br />
                  <span className="muted small">
                    {b.series ? 'Monthly · ' : ''}
                    {formatWhen(b.start, b.end)} · {formatRupees(b.totalPaise)}
                    {b.approvalExpiresAt ? ` · respond by ${formatTime(b.approvalExpiresAt)}` : ''}
                  </span>
                </span>
                <span className="row-start">
                  <button
                    type="button"
                    disabled={busyId === b.id}
                    onClick={() => void respond(b.id, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="link"
                    disabled={busyId === b.id}
                    onClick={() => void respond(b.id, 'decline')}
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="arrivals-h">
        <h2 id="arrivals-h">Next 48 hours</h2>
        {arrivals.length === 0 ? (
          <p className="muted">No arrivals coming up.</p>
        ) : (
          <ul className="list">
            {arrivals.map((b) => (
              <li key={b.id}>
                <span>
                  <Link href={`/host/bookings/${b.id}`}>{b.listing.title}</Link>
                  <br />
                  <span className="muted small">
                    {formatWhen(b.start, b.end)} · {b.customer.name}
                    {b.vehicle ? ` · ${b.vehicle.plate}` : ''}
                    {b.unitLabel ? ` · space ${b.unitLabel}` : ''}
                  </span>
                </span>
                <span className="small">
                  {b.status === 'PENDING_PAYMENT' ? 'Awaiting payment' : 'Confirmed'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="listings-h">
        <h2 id="listings-h">Your listings</h2>
        {listings.length === 0 ? (
          <div className="empty">
            <p>You haven&apos;t listed a space yet.</p>
            <Link className="button" href="/host/listings/new">
              List a parking space
            </Link>
          </div>
        ) : (
          <p>
            {listings.filter((l) => l.status === 'PUBLISHED').length} live
            {drafts.length ? ` · ${drafts.length} draft${drafts.length > 1 ? 's' : ''} to finish` : ''} ·{' '}
            <Link href="/host/listings">Manage listings</Link>
          </p>
        )}
        {drafts.slice(0, 3).map((d) => (
          <p key={d.id} className="small">
            <Link href={`/host/listings/${d.id}`}>{d.title}</Link>: {ASSET_STATUS_LABEL[d.status]},{' '}
            {d.missing.length} step
            {d.missing.length === 1 ? '' : 's'} left
          </p>
        ))}
      </section>
    </div>
  );
}
