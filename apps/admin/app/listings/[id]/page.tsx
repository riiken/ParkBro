'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { use } from 'react';
import { Json, ReasonAction, useApi } from '../../../lib/admin';

interface Asset {
  id: string;
  title: string;
  type: string;
  status: string;
  statusReason: string | null;
  description: string;
  rulesText: string;
  hostAccountId: string;
  media: {
    id: string;
    kind: string;
    url: string;
    duplicateSuspected: boolean;
    captureDistanceM: number | null;
  }[];
  checklist: { ready: boolean; missing: string[] };
  parkingDetails: unknown;
  chargerDetails: unknown;
  rates: unknown;
}

/** AJ-1 listing review: photos (with duplicate and capture-distance flags), facts, decision with a reason. */
export default function ListingReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: a, error, reload } = useApi<Asset>(`/api/admin/assets/${id}`);
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!a) return <p aria-busy="true">Loading…</p>;
  const act = (action: string, reason?: string) =>
    apiRequest(`/api/admin/assets/${id}/${action}`, { method: 'POST', body: reason ? { reason } : {} }).then(
      reload,
    );
  return (
    <div>
      <p>
        <Link href="/listings">← Listings</Link>
      </p>
      <h1>{a.title}</h1>
      <p>
        {a.type} · <strong>{a.status}</strong>
        {a.statusReason ? ` · ${a.statusReason}` : ''} ·{' '}
        <Link href={`/listings?hostAccountId=${a.hostAccountId}`}>host&apos;s listings</Link>
      </p>
      <ul className="thumbs">
        {a.media.map((m) => (
          <li key={m.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- private admin media */}
            <img src={m.url} alt={`${m.kind} photo`} />
            <div className="small">
              {m.kind}
              {m.duplicateSuspected ? <span className="badge high"> possible duplicate</span> : null}
              {m.captureDistanceM !== null ? ` · taken ${m.captureDistanceM} m away` : ''}
            </div>
          </li>
        ))}
      </ul>
      <div className="panel">
        <p>{a.description}</p>
        <p className="muted">{a.rulesText}</p>
        {!a.checklist.ready ? <p className="form-error">Missing: {a.checklist.missing.join(', ')}</p> : null}
        <details>
          <summary>Details</summary>
          <Json value={{ parking: a.parkingDetails, charger: a.chargerDetails, rates: a.rates }} />
        </details>
      </div>
      <div className="panel">
        {a.status === 'PENDING_REVIEW' ? (
          <>
            <button type="button" onClick={() => void act('approve')}>
              Approve
            </button>{' '}
            <ReasonAction
              label="Reject"
              danger
              run={(r) => act('reject', r)}
              placeholder="Reason shown to the host"
            />
          </>
        ) : null}
        {a.status === 'PUBLISHED' || a.status === 'PAUSED' ? (
          <ReasonAction label="Suspend listing" danger run={(r) => act('suspend', r)} />
        ) : null}
        {a.status === 'SUSPENDED' ? (
          <>
            <ReasonAction label="Reinstate" run={(r) => act('reinstate', r)} />
            <p className="small muted">
              Reinstating returns it to Paused: the host publishes it again when ready.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
