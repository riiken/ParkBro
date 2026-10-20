'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FormError } from '../../../components/field';
import { HostGate } from '../../../components/host-gate';
import { STATUS_LABEL, formatRupees, formatWhen } from '../../../lib/booking';
import type { HostBooking } from '../../../lib/host';

const GROUPS: { title: string; statuses: string[] }[] = [
  { title: 'Requests', statuses: ['AWAITING_HOST_APPROVAL'] },
  { title: 'Upcoming and in progress', statuses: ['PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS'] },
  { title: 'Past', statuses: ['COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED', 'NO_SHOW'] },
];

/** H-06/H-07 entry: every booking on the host's listings, grouped by what needs attention. */
export function HostBookings() {
  return <HostGate>{() => <List />}</HostGate>;
}

function List() {
  const [bookings, setBookings] = useState<HostBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<HostBooking[]>('/api/v1/host/bookings')
      .then(setBookings)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.userMessage : 'Could not load bookings.'));
  }, []);
  if (error) return <FormError message={error} />;
  if (!bookings) return <p aria-busy="true">Loading bookings…</p>;
  if (bookings.length === 0)
    return <p className="empty">No bookings yet. They appear here as soon as a customer books.</p>;
  return (
    <div>
      <h1>Bookings</h1>
      {GROUPS.map((g) => {
        const rows = bookings.filter((b) => g.statuses.includes(b.status));
        if (g.title !== 'Past') rows.reverse();
        return rows.length ? (
          <section key={g.title}>
            <h2>{g.title}</h2>
            <ul className="list">
              {rows.map((b) => (
                <li key={b.id}>
                  <span>
                    <Link href={`/host/bookings/${b.id}`}>
                      {b.customer.name} · {b.listing.title}
                    </Link>
                    <br />
                    <span className="muted small">
                      {b.series ? `Monthly, month ${b.series.periodIndex} · ` : ''}
                      {formatWhen(b.start, b.end)}
                    </span>
                  </span>
                  <span className="small">
                    <span className={`status status-${b.status.toLowerCase()}`}>
                      {STATUS_LABEL[b.status] ?? b.status}
                    </span>
                    <br />
                    {formatRupees(b.totalPaise)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null;
      })}
    </div>
  );
}
