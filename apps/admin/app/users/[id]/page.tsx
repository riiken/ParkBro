'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { use } from 'react';
import { PagedList, ReasonAction, short, useApi, when, type Page } from '../../../lib/admin';

interface User {
  id: string;
  displayName: string;
  phoneMasked: string;
  status: string;
  locale: string;
  roles: string[];
  hostAccounts: { id: string; displayName: string; status: string; role: string }[];
  activeSessions: number;
  createdAt: string;
}

export default function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: u, error, reload } = useApi<User>(`/api/admin/v1/users/${id}`);
  const bookings = useApi<Page<unknown>>(`/api/admin/v1/bookings?customerId=${id}&limit=1`);
  const clearance = useApi<{
    required: boolean;
    status: 'CLEARED' | 'REVOKED' | 'NONE';
    history: { decision: string; reason: string | null; at: string }[];
  }>(`/api/admin/v1/users/${id}/clearance`);
  const decide = (decision: 'CLEARED' | 'REVOKED') => (reason: string) =>
    apiRequest(`/api/admin/v1/users/${id}/clearance`, { method: 'POST', body: { decision, reason } }).then(
      clearance.reload,
    );
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!u) return <p aria-busy="true">Loading…</p>;
  return (
    <div>
      <p>
        <Link href="/users">← Users</Link>
      </p>
      <h1>{u.displayName}</h1>
      <p>
        {u.phoneMasked} · {u.status} · roles {u.roles.join(', ')} · joined {when(u.createdAt)} ·{' '}
        {u.activeSessions} active session(s) · {bookings.data?.total ?? '…'} booking(s)
      </p>
      {u.hostAccounts.map((h) => (
        <p key={h.id}>
          Host account <strong>{h.displayName}</strong> ({h.role}, {h.status}) ·{' '}
          <Link href={`/listings?hostAccountId=${h.id}`}>listings</Link>
        </p>
      ))}
      <div className="panel">
        {u.status === 'ACTIVE' ? (
          <ReasonAction
            label="Suspend user"
            danger
            run={(reason) =>
              apiRequest(`/api/admin/v1/users/${id}/suspend`, { method: 'POST', body: { reason } }).then(
                reload,
              )
            }
          />
        ) : u.status === 'SUSPENDED' ? (
          <ReasonAction
            label="Reinstate user"
            run={(reason) =>
              apiRequest(`/api/admin/v1/users/${id}/reinstate`, { method: 'POST', body: { reason } }).then(
                reload,
              )
            }
          />
        ) : null}
      </div>
      {u.roles.includes('CUSTOMER') && clearance.data ? (
        <div className="panel">
          <h2>Pilot clearance</h2>
          <p>
            {clearance.data.status === 'CLEARED'
              ? 'Cleared to book.'
              : clearance.data.status === 'REVOKED'
                ? 'Clearance revoked.'
                : 'Not cleared yet.'}{' '}
            <span className="muted small">
              {clearance.data.required
                ? 'Clearance is required to book during the pilot.'
                : 'Clearance is not enforced in this environment.'}
            </span>
          </p>
          {clearance.data.status === 'CLEARED' ? (
            <ReasonAction label="Revoke clearance" danger run={decide('REVOKED')} />
          ) : (
            <ReasonAction
              label="Clear to book"
              placeholder="What you checked (e.g. RC and ID on a call)"
              run={decide('CLEARED')}
            />
          )}
          {clearance.data.history.map((x) => (
            <p key={x.at} className="small muted">
              {when(x.at)} · {x.decision} · {x.reason}
            </p>
          ))}
        </div>
      ) : null}
      <h2>Bookings</h2>
      <PagedList<{ id: string; status: string; start: string; totalPaise: number }>
        base={`/api/admin/v1/bookings?customerId=${id}`}
        rowKey={(b) => b.id}
        columns={[
          { label: 'Booking', render: (b) => <Link href={`/bookings/${b.id}`}>{short(b.id)}</Link> },
          { label: 'Status', render: (b) => b.status },
          { label: 'Start', render: (b) => when(b.start) },
        ]}
      />
      <h2>Audit</h2>
      <PagedList<{ id: string; action: string; at: string; actorKind: string }>
        base={`/api/admin/v1/audit?entityKind=user&entityId=${id}`}
        rowKey={(e) => e.id}
        empty="No entries (or you lack audit access)."
        columns={[
          { label: 'When', render: (e) => when(e.at) },
          { label: 'Action', render: (e) => e.action },
          { label: 'By', render: (e) => e.actorKind },
        ]}
      />
    </div>
  );
}
