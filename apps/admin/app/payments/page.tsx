'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { Json, money, PagedList, ReasonAction, short, useApi, when } from '../../lib/admin';

interface P {
  id: string;
  bookingId: string;
  provider: string;
  status: string;
  amountPaise: number;
  method: string | null;
  mismatch: boolean;
  createdAt: string;
}
interface R {
  id: string;
  bookingId: string;
  amountPaise: number;
  reason: string;
  status: string;
  attempts: number;
  createdAt: string;
}

/** A-05 finance: payments, refunds, reconciliation queue (FINANCE). */
export default function PaymentsPage() {
  const recon = useApi<{ id: string; kind: string; refs: unknown; createdAt: string }[]>(
    '/api/admin/v1/payments/reconciliation',
  );
  const trial = useApi<{ balanced: boolean; debitPaise: number; creditPaise: number }>(
    '/api/admin/v1/ledger/trial-balance',
  );
  return (
    <div>
      <h1>Payments</h1>
      {trial.data ? (
        <p className={trial.data.balanced ? 'success' : 'form-error'}>
          Ledger {trial.data.balanced ? 'balanced' : 'NOT balanced'}: debits {money(trial.data.debitPaise)} ·
          credits {money(trial.data.creditPaise)}
        </p>
      ) : null}
      <section className="panel">
        <h2>Reconciliation ({recon.data?.length ?? '…'})</h2>
        {recon.error ? <p className="muted">{recon.error}</p> : null}
        {recon.data?.map((i) => (
          <div key={i.id}>
            <p>
              <strong>{i.kind}</strong> · {when(i.createdAt)}
            </p>
            <Json value={i.refs} />
            <ReasonAction
              label="Mark resolved"
              placeholder="What was done (audit)"
              run={(note) =>
                apiRequest(`/api/admin/v1/payments/reconciliation/${i.id}/resolve`, {
                  method: 'POST',
                  body: { note },
                }).then(recon.reload)
              }
            />
          </div>
        ))}
      </section>
      <h2>Payments</h2>
      <PagedList<P>
        base="/api/admin/v1/payments"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: ['CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED'].map((s) => [s, s]),
          },
        ]}
        rowKey={(p) => p.id}
        columns={[
          { label: 'When', render: (p) => when(p.createdAt) },
          {
            label: 'Booking',
            render: (p) => <Link href={`/bookings/${p.bookingId}`}>{short(p.bookingId)}</Link>,
          },
          { label: 'Status', render: (p) => `${p.status}${p.mismatch ? ' · MISMATCH' : ''}` },
          { label: 'Amount', render: (p) => money(p.amountPaise) },
          { label: 'Method', render: (p) => `${p.provider} ${p.method ?? ''}` },
        ]}
      />
      <h2>Refunds</h2>
      <PagedList<R>
        base="/api/admin/v1/refunds"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: ['PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED'].map((s) => [s, s]),
          },
        ]}
        rowKey={(r) => r.id}
        columns={[
          { label: 'When', render: (r) => when(r.createdAt) },
          {
            label: 'Booking',
            render: (r) => <Link href={`/bookings/${r.bookingId}`}>{short(r.bookingId)}</Link>,
          },
          { label: 'Reason', render: (r) => r.reason },
          { label: 'Status', render: (r) => `${r.status}${r.attempts > 1 ? ` (${r.attempts} tries)` : ''}` },
          { label: 'Amount', render: (r) => money(r.amountPaise) },
        ]}
      />
    </div>
  );
}
