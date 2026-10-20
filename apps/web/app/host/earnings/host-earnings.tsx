'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FormError } from '../../../components/field';
import { HostGate } from '../../../components/host-gate';
import { formatDate, formatRupees } from '../../../lib/booking';
import type { HostAccount } from '../../../lib/host';

interface Earnings {
  balances: {
    pendingPaise: number;
    availablePaise: number;
    inPayoutPaise: number;
    paidPaise: number;
    receivablePaise: number;
  };
  releaseAfterHours: number;
  minPayoutPaise: number;
  bookings: {
    bookingId: string;
    customerPaidPaise: number;
    refundedPaise: number;
    grossPaise: number;
    serviceFeePaise: number;
    commissionPaise: number;
    taxPaise: number;
    netPaise: number;
    status: 'PENDING' | 'RELEASED' | 'SETTLED';
    firstAt: string;
  }[];
}
interface Payout {
  id: string;
  amountPaise: number;
  status: 'PROCESSING' | 'PAID' | 'FAILED';
  reference: string | null;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}
interface PayoutAccount {
  id: string;
  method: 'UPI' | 'BANK';
  holderName: string;
  display: string;
  status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | 'REPLACED';
  holdUntil: string | null;
}

/** H-09 earnings and H-10 payouts (ux §7.10): gross, fees, commission, net; pending vs available vs paid. */
export function HostEarnings() {
  return <HostGate>{(account) => <View account={account} />}</HostGate>;
}

function View({ account }: { account: HostAccount }) {
  const [data, setData] = useState<{
    e: Earnings;
    payouts: Payout[];
    payoutAccount: PayoutAccount | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<'UPI' | 'BANK'>('UPI');
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, payouts, payoutAccount] = await Promise.all([
        apiRequest<Earnings>('/api/v1/host/earnings'),
        apiRequest<Payout[]>('/api/v1/host/payouts'),
        apiRequest<PayoutAccount | null>('/api/v1/host/payout-account'),
      ]);
      setData({ e, payouts, payoutAccount });
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : 'Could not load your earnings.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setFormError(null);
    try {
      await apiRequest('/api/v1/host/payout-account', {
        method: 'PUT',
        body:
          method === 'UPI'
            ? { method, holderName: String(f.get('holderName') ?? ''), vpa: String(f.get('vpa') ?? '') }
            : {
                method,
                holderName: String(f.get('holderName') ?? ''),
                accountNumber: String(f.get('accountNumber') ?? ''),
                ifsc: String(f.get('ifsc') ?? ''),
              },
      });
      setEditing(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.userMessage : 'Could not save payout details.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <FormError message={error} />;
  if (!data) return <p aria-busy="true">Loading earnings…</p>;
  const { e, payouts, payoutAccount } = data;
  const b = e.balances;
  const canEdit = account.role === 'OWNER' && account.status === 'ACTIVE';
  return (
    <div>
      <h1>Earnings</h1>
      <section aria-labelledby="balances-h" className="section">
        <h2 id="balances-h" className="visually-hidden">
          Balances
        </h2>
        <table className="prices">
          <tbody>
            <tr>
              <th scope="row">
                Pending{' '}
                <span className="muted small">
                  (released {e.releaseAfterHours} h after each booking ends)
                </span>
              </th>
              <td>{formatRupees(b.pendingPaise)}</td>
            </tr>
            <tr>
              <th scope="row">Available for payout</th>
              <td>{formatRupees(b.availablePaise)}</td>
            </tr>
            <tr>
              <th scope="row">Being paid out</th>
              <td>{formatRupees(b.inPayoutPaise)}</td>
            </tr>
            <tr>
              <th scope="row">Paid to you</th>
              <td>{formatRupees(b.paidPaise)}</td>
            </tr>
            {b.receivablePaise > 0 ? (
              <tr>
                <th scope="row">Owed back (refunds after payout, taken from the next payout)</th>
                <td>−{formatRupees(b.receivablePaise)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="small muted">
          Payouts go out weekly when at least {formatRupees(e.minPayoutPaise)} is available.
        </p>
      </section>

      <section aria-labelledby="account-h" className="section">
        <h2 id="account-h">Payout account</h2>
        {payoutAccount && !editing ? (
          <p>
            {payoutAccount.method === 'UPI' ? 'UPI' : 'Bank'} {payoutAccount.display} ·{' '}
            {payoutAccount.holderName} · {payoutAccount.status === 'VERIFIED' ? 'Verified' : 'Being verified'}
            {payoutAccount.holdUntil
              ? ` · payouts resume ${formatDate(payoutAccount.holdUntil)} (account changed)`
              : ''}
            {canEdit ? (
              <>
                {' '}
                <button type="button" className="link" onClick={() => setEditing(true)}>
                  Change
                </button>
              </>
            ) : null}
          </p>
        ) : canEdit ? (
          <form onSubmit={saveAccount} noValidate aria-label="Payout account">
            <fieldset className="segmented">
              <legend>Get paid by</legend>
              {(['UPI', 'BANK'] as const).map((m) => (
                <label key={m} className={method === m ? 'active' : undefined}>
                  <input type="radio" name="method" checked={method === m} onChange={() => setMethod(m)} />{' '}
                  {m === 'UPI' ? 'UPI' : 'Bank transfer'}
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor="holderName">Account holder name</label>
              <input id="holderName" name="holderName" required maxLength={100} />
            </div>
            {method === 'UPI' ? (
              <div className="field">
                <label htmlFor="vpa">UPI ID</label>
                <input id="vpa" name="vpa" placeholder="name@bank" autoCapitalize="none" required />
              </div>
            ) : (
              <div className="row">
                <div className="field">
                  <label htmlFor="accountNumber">Account number</label>
                  <input id="accountNumber" name="accountNumber" inputMode="numeric" required />
                </div>
                <div className="field">
                  <label htmlFor="ifsc">IFSC</label>
                  <input id="ifsc" name="ifsc" autoCapitalize="characters" maxLength={11} required />
                </div>
              </div>
            )}
            <p className="hint">
              We check the account belongs to you before the first payout. Changing it later pauses payouts
              for 72 hours.
            </p>
            <FormError message={formError} />
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save payout account'}
            </button>
          </form>
        ) : (
          <p className="muted">Only the account owner can add payout details.</p>
        )}
      </section>

      <section aria-labelledby="per-booking-h" className="section">
        <h2 id="per-booking-h">By booking</h2>
        {e.bookings.length === 0 ? (
          <p className="muted">Earnings appear here once a customer pays.</p>
        ) : (
          <ul className="list">
            {e.bookings.map((x) => (
              <li key={x.bookingId}>
                <span>
                  <Link href={`/host/bookings/${x.bookingId}`}>Booking of {formatDate(x.firstAt)}</Link>
                  <br />
                  <span className="muted small">
                    Gross {formatRupees(x.grossPaise)} · commission −{formatRupees(x.commissionPaise)}
                    {x.taxPaise ? ` · tax −${formatRupees(x.taxPaise)}` : ''}
                    {x.serviceFeePaise
                      ? ` · customer fee ${formatRupees(x.serviceFeePaise)} (not yours)`
                      : ''}
                    {x.refundedPaise ? ` · refunded ${formatRupees(x.refundedPaise)}` : ''}
                  </span>
                </span>
                <span className="small">
                  <strong>{formatRupees(x.netPaise)}</strong>
                  <br />
                  {x.status === 'PENDING' ? 'Pending' : 'Released'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="payouts-h" className="section">
        <h2 id="payouts-h">Payouts</h2>
        {payouts.length === 0 ? (
          <p className="muted">No payouts yet.</p>
        ) : (
          <ul className="list">
            {payouts.map((p) => (
              <li key={p.id}>
                <span>
                  {formatDate(p.createdAt)}
                  {p.reference ? <span className="muted small"> · ref {p.reference}</span> : null}
                  {p.failureReason ? (
                    <span className="muted small">
                      {' '}
                      · {p.failureReason}; the amount is back in your balance
                    </span>
                  ) : null}
                </span>
                <span className="small">
                  <strong>{formatRupees(p.amountPaise)}</strong>
                  <br />
                  {p.status === 'PAID' ? 'Paid' : p.status === 'FAILED' ? 'Failed' : 'On its way'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
