'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { use } from 'react';
import { money, PagedList, ReasonAction, useApi, when } from '../../../lib/admin';

interface B {
  id: string;
  status: string;
  listing: { id: string; title: string };
  unitLabel: string | null;
  mode: string;
  start: string;
  end: string;
  customer: { name: string };
  customerId: string;
  hostAccountId: string;
  vehicle: { plate: string; vehicleClass: string } | null;
  totalPaise: number;
  issue: { kind: string; status: string } | null;
  events: { from: string | null; to: string; actor: string; reason: string | null; at: string }[];
}

export default function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: b, error, reload } = useApi<B>(`/api/admin/v1/bookings/${id}`);
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!b) return <p aria-busy="true">Loading…</p>;
  return (
    <div>
      <p>
        <Link href="/bookings">← Bookings</Link>
      </p>
      <h1>
        <Link href={`/listings/${b.listing.id}`}>{b.listing.title}</Link>
      </h1>
      <p>
        <strong>{b.status}</strong> · {b.mode} · {when(b.start)} → {when(b.end)} · space {b.unitLabel ?? '—'}{' '}
        · {money(b.totalPaise)}
      </p>
      <p>
        Customer <Link href={`/users/${b.customerId}`}>{b.customer.name}</Link>
        {b.vehicle ? ` · ${b.vehicle.plate} (${b.vehicle.vehicleClass})` : ''}
        {b.issue ? ` · issue ${b.issue.kind} (${b.issue.status})` : ''}
      </p>
      {['AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS'].includes(b.status) ? (
        <div className="panel">
          <ReasonAction
            label="Cancel for the platform (full refund)"
            danger
            run={(reason) =>
              apiRequest(`/api/admin/v1/bookings/${id}/cancel`, { method: 'POST', body: { reason } }).then(
                reload,
              )
            }
          />
        </div>
      ) : null}
      <h2>History</h2>
      <table className="table">
        <tbody>
          {b.events.map((e, i) => (
            <tr key={i}>
              <td>{when(e.at)}</td>
              <td>
                {e.from ?? '—'} → <strong>{e.to}</strong>
              </td>
              <td>{e.actor}</td>
              <td className="muted">{e.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Payments</h2>
      <PagedList<{ id: string; status: string; amountPaise: number; createdAt: string; mismatch: boolean }>
        base={`/api/admin/v1/payments?bookingId=${id}`}
        rowKey={(p) => p.id}
        empty="No payments (or no FINANCE permission)."
        columns={[
          { label: 'When', render: (p) => when(p.createdAt) },
          { label: 'Status', render: (p) => `${p.status}${p.mismatch ? ' · MISMATCH' : ''}` },
          { label: 'Amount', render: (p) => money(p.amountPaise) },
        ]}
      />
    </div>
  );
}
