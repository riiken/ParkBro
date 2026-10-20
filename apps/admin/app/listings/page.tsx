'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PagedList, useApi, when } from '../../lib/admin';

interface A {
  id: string;
  title: string;
  type: string;
  status: string;
  updatedAt: string;
}

function Listings() {
  const host = useSearchParams().get('hostAccountId');
  const queue =
    useApi<{ id: string; title: string; type: string; updatedAt: string }[]>('/api/admin/review/assets');
  return (
    <div>
      <h1>Listings</h1>
      <section className="panel">
        <h2>Waiting for review ({queue.data?.length ?? '…'})</h2>
        {queue.data?.length === 0 ? <p className="muted">Nothing to review.</p> : null}
        {queue.data?.map((a) => (
          <p key={a.id}>
            <Link href={`/listings/${a.id}`}>{a.title}</Link> · {a.type} · submitted {when(a.updatedAt)}
          </p>
        ))}
        {queue.error ? <p className="muted">{queue.error}</p> : null}
      </section>
      <h2>All listings</h2>
      <PagedList<A>
        base={`/api/admin/v1/assets${host ? `?hostAccountId=${host}` : ''}`}
        filters={[
          { name: 'q', label: 'Title' },
          {
            name: 'status',
            label: 'Status',
            options: [
              ['DRAFT', 'Draft'],
              ['PENDING_REVIEW', 'In review'],
              ['PUBLISHED', 'Live'],
              ['PAUSED', 'Paused'],
              ['SUSPENDED', 'Suspended'],
              ['ARCHIVED', 'Archived'],
            ],
          },
          {
            name: 'type',
            label: 'Type',
            options: [
              ['PARKING', 'Parking'],
              ['EV_CHARGING', 'EV charging'],
            ],
          },
        ]}
        rowKey={(a) => a.id}
        columns={[
          { label: 'Title', render: (a) => <Link href={`/listings/${a.id}`}>{a.title}</Link> },
          { label: 'Type', render: (a) => a.type },
          { label: 'Status', render: (a) => a.status },
          { label: 'Updated', render: (a) => when(a.updatedAt) },
        ]}
      />
    </div>
  );
}

export default function ListingsPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Listings />
    </Suspense>
  );
}
