'use client';

import { apiRequest } from '@parkbro/web-kit';
import { money, PagedList, ReasonAction, short, useApi, when } from '../../lib/admin';

interface Acct {
  id: string;
  hostAccountId: string;
  method: string;
  holderName: string;
  details: string;
  createdAt: string;
}
interface Payout {
  id: string;
  hostAccountId: string;
  amountPaise: number;
  status: string;
  reference: string | null;
  createdAt: string;
}

/** A-05 payouts: verify payout accounts (manual penny-drop/name check), record transfers (MANUAL provider). */
export default function PayoutsPage() {
  const accounts = useApi<Acct[]>('/api/admin/v1/payout-accounts/pending');
  const open = useApi<Payout[]>('/api/admin/v1/payouts/open');
  const review = (id: string, decision: 'VERIFIED' | 'REJECTED') =>
    apiRequest(`/api/admin/v1/payout-accounts/${id}/review`, { method: 'POST', body: { decision } }).then(
      accounts.reload,
    );
  return (
    <div>
      <h1>Payouts</h1>
      <section className="panel">
        <h2>Payout accounts to verify ({accounts.data?.length ?? '…'})</h2>
        {accounts.error ? <p className="muted">{accounts.error}</p> : null}
        {accounts.data?.map((a) => (
          <p key={a.id}>
            <strong>{a.holderName}</strong> · {a.method} · <code>{a.details}</code> · host{' '}
            {short(a.hostAccountId)} · {when(a.createdAt)}{' '}
            <button type="button" onClick={() => void review(a.id, 'VERIFIED')}>
              Verified
            </button>{' '}
            <button type="button" className="danger" onClick={() => void review(a.id, 'REJECTED')}>
              Reject
            </button>
          </p>
        ))}
      </section>
      <section className="panel">
        <h2>To send ({open.data?.length ?? '…'})</h2>
        {open.data?.map((p) => (
          <div key={p.id}>
            <p>
              <strong>{money(p.amountPaise)}</strong> · host {short(p.hostAccountId)} · {when(p.createdAt)}
            </p>
            <ReasonAction
              label="Mark paid"
              placeholder="Bank / UPI reference (UTR)"
              minLength={4}
              run={(reference) =>
                apiRequest(`/api/admin/v1/payouts/${p.id}/settle`, {
                  method: 'POST',
                  body: { status: 'PAID', reference },
                }).then(open.reload)
              }
            />{' '}
            <ReasonAction
              label="Mark failed"
              danger
              minLength={4}
              run={(reason) =>
                apiRequest(`/api/admin/v1/payouts/${p.id}/settle`, {
                  method: 'POST',
                  body: { status: 'FAILED', reason },
                }).then(open.reload)
              }
            />
          </div>
        ))}
      </section>
      <h2>All payouts</h2>
      <PagedList<Payout>
        base="/api/admin/v1/payouts"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: [
              ['PROCESSING', 'Processing'],
              ['PAID', 'Paid'],
              ['FAILED', 'Failed'],
            ],
          },
        ]}
        rowKey={(p) => p.id}
        columns={[
          { label: 'When', render: (p) => when(p.createdAt) },
          { label: 'Host', render: (p) => short(p.hostAccountId) },
          { label: 'Amount', render: (p) => money(p.amountPaise) },
          { label: 'Status', render: (p) => p.status },
          { label: 'Reference', render: (p) => p.reference ?? '—' },
        ]}
      />
    </div>
  );
}
