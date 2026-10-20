'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { use } from 'react';
import { Json, money, ReasonAction, useApi, when } from '../../../lib/admin';

interface D {
  id: string;
  bookingId: string;
  category: string;
  risk: 'LOW' | 'HIGH';
  status: string;
  requestedOutcome: string;
  outcome: string | null;
  refundPaise: number | null;
  resolutionNote: string | null;
  customer: { name: string; trust: unknown };
  host: { hostAccountId: string; trust: unknown };
  messages: { author: string; body: string; internal: boolean; at: string }[];
  evidence: { id: string; by: string }[];
  bookingEvents: { from: string | null; to: string; actor: string; reason: string | null; at: string }[];
  accessEvents: { kind: string; source: string; method: string | null; gate: string | null; at: string }[];
  money: {
    payments: { status: string; amountPaise: number }[];
    refunds: { reason: string; status: string; amountPaise: number }[];
  };
  reviews: unknown[];
}

/**
 * Dispute decision (A-03). The evidence pack comes from systems of record; the decision is a person's, with a note.
 * HIGH risk can be decided only with TRUST_SAFETY (the API enforces it).
 */
export default function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: d, error, reload } = useApi<D>(`/api/admin/v1/disputes/${id}`);
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!d) return <p aria-busy="true">Loading…</p>;
  const act = (action: string, note: string | null) =>
    apiRequest(`/api/admin/v1/disputes/${id}/${action}`, { method: 'POST', body: { note } }).then(reload);
  const open = d.status !== 'RESOLVED' && d.status !== 'CLOSED';
  return (
    <div>
      <p>
        <Link href="/disputes">← Disputes</Link>
      </p>
      <h1>
        {d.category} <span className={`badge ${d.risk === 'HIGH' ? 'high' : ''}`}>{d.risk}</span>
      </h1>
      <p>
        <strong>{d.status}</strong> · wants {d.requestedOutcome} ·{' '}
        <Link href={`/bookings/${d.bookingId}`}>booking</Link> · customer {d.customer.name}
      </p>
      {d.outcome ? (
        <p className="panel">
          Decided: {d.outcome} {d.refundPaise ? `(${money(d.refundPaise)})` : ''} · {d.resolutionNote}
        </p>
      ) : null}
      <section className="panel">
        <h2>Timeline</h2>
        {d.messages.map((m, i) => (
          <p key={i}>
            <strong>{m.author}</strong>
            {m.internal ? <span className="badge"> internal</span> : null} · {when(m.at)}
            <br />
            {m.body}
          </p>
        ))}
        {d.evidence.length ? (
          <ul className="thumbs">
            {d.evidence.map((e) => (
              <li key={e.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- private evidence */}
                <img src={`/api/admin/v1/dispute-evidence/${e.id}`} alt={`Evidence from ${e.by}`} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {open ? (
        <section className="panel">
          <h2>Act</h2>
          <ReasonAction
            label="Start review (internal note)"
            run={(n) => act('review', n)}
            placeholder="Internal note"
            minLength={1}
          />{' '}
          <ReasonAction
            label="Ask the parties for information"
            run={(n) => act('request-info', n)}
            placeholder="Message to both parties"
          />{' '}
          <ReasonAction
            label="Escalate"
            run={(n) => act('escalate', n)}
            placeholder="Internal note"
            minLength={1}
          />
          <h3>Decision</h3>
          <ReasonAction
            label="Resolve"
            danger
            placeholder="Decision note (shared with the parties)"
            extra={
              <>
                <select name="outcome" defaultValue="NO_ACTION" aria-label="Outcome">
                  <option value="NO_ACTION">No action</option>
                  <option value="REFUND_FULL">Full refund</option>
                  <option value="REFUND_PARTIAL">Partial refund</option>
                  <option value="WARNING">Warning</option>
                  <option value="RESTRICT_ACCOUNT">
                    Restrict account (then change the host/user status)
                  </option>
                </select>
                <input
                  name="refund"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Partial refund ₹"
                  aria-label="Partial refund in rupees"
                />
              </>
            }
            run={(note, f) => {
              const outcome = String(f.get('outcome'));
              const rupees = Number(f.get('refund') || 0);
              return apiRequest(`/api/admin/v1/disputes/${id}/resolve`, {
                method: 'POST',
                body: {
                  outcome,
                  note,
                  ...(outcome === 'REFUND_PARTIAL' ? { refundPaise: Math.round(rupees * 100) } : {}),
                },
              }).then(reload);
            }}
          />
        </section>
      ) : d.status === 'RESOLVED' ? (
        <button type="button" className="secondary" onClick={() => void act('close', null)}>
          Close dispute
        </button>
      ) : null}
      <section className="panel">
        <h2>Evidence pack</h2>
        <h3>Booking history</h3>
        <table className="table">
          <tbody>
            {d.bookingEvents.map((e, i) => (
              <tr key={i}>
                <td>{when(e.at)}</td>
                <td>
                  {e.from ?? '—'} → {e.to}
                </td>
                <td>{e.actor}</td>
                <td className="muted">{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Access</h3>
        {d.accessEvents.length === 0 ? <p className="muted">No access events.</p> : null}
        {d.accessEvents.map((e, i) => (
          <p key={i} className="small">
            {when(e.at)} · {e.kind} · {e.source} {e.method ?? ''} {e.gate ? `· ${e.gate}` : ''}
          </p>
        ))}
        <h3>Money</h3>
        <Json value={d.money} />
        <h3>Trust signals</h3>
        <Json value={{ customer: d.customer.trust, host: d.host.trust }} />
        <h3>Reviews</h3>
        <Json value={d.reviews} />
      </section>
    </div>
  );
}
