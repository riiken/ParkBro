'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FormError } from '../../../components/field';
import { HostGate } from '../../../components/host-gate';
import { ASSET_STATUS_LABEL, type HostAssetSummary } from '../../../lib/host';

/** H-03 Listings: status badges and the way into the editor and calendar. */
export function HostListings() {
  return <HostGate>{() => <List />}</HostGate>;
}

function List() {
  const [listings, setListings] = useState<HostAssetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<HostAssetSummary[]>('/api/v1/host/assets')
      .then(setListings)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.userMessage : 'Could not load your listings.'),
      );
  }, []);

  if (error) return <FormError message={error} />;
  if (!listings) return <p aria-busy="true">Loading listings…</p>;
  return (
    <div>
      <div className="row">
        <h1>Your listings</h1>
        <Link className="button" href="/host/listings/new">
          New listing
        </Link>
      </div>
      {listings.length === 0 ? (
        <div className="empty">
          <p>No listings yet. Most hosts publish in about 10 minutes.</p>
        </div>
      ) : (
        <ul className="list">
          {listings.map((l) => (
            <li key={l.id}>
              <span>
                <Link href={`/host/listings/${l.id}`}>{l.title}</Link>
                <br />
                <span className="muted small">
                  {l.type === 'PARKING' ? 'Parking' : 'EV charging'}
                  {l.status === 'DRAFT' && l.missing.length ? ` · ${l.missing.length} steps left` : ''}
                  {l.needsReview && l.status !== 'DRAFT' ? ' · changes need review' : ''}
                </span>
              </span>
              <span className="row-start">
                <span className={`status status-${l.status.toLowerCase()}`}>
                  {ASSET_STATUS_LABEL[l.status] ?? l.status}
                </span>
                {l.status !== 'ARCHIVED' ? (
                  <Link href={`/host/listings/${l.id}/calendar`}>Calendar</Link>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
