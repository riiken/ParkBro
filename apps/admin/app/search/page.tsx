'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { short, useApi, when, type Page } from '../../lib/admin';

function Results() {
  const q = useSearchParams().get('q')?.trim() ?? '';
  const enc = encodeURIComponent(q);
  const users = useApi<Page<{ id: string; displayName: string; phoneMasked: string; status: string }>>(
    q ? `/api/admin/v1/users?q=${enc}&limit=10` : null,
  );
  const hosts = useApi<Page<{ id: string; displayName: string; status: string }>>(
    q ? `/api/admin/v1/hosts?q=${enc}&limit=10` : null,
  );
  const assets = useApi<Page<{ id: string; title: string; status: string }>>(
    q ? `/api/admin/v1/assets?q=${enc}&limit=10` : null,
  );
  const bookings = useApi<Page<{ id: string; status: string; start: string }>>(
    /^[0-9a-f-]{8,36}$/i.test(q) ? `/api/admin/v1/bookings?q=${enc}&limit=10` : null,
  );
  return (
    <div>
      <h1>Search: {q}</h1>
      <section className="panel">
        <h2>Users</h2>
        {users.data?.items.map((u) => (
          <p key={u.id}>
            <Link href={`/users/${u.id}`}>{u.displayName}</Link> · {u.phoneMasked} · {u.status}
          </p>
        )) ?? <p className="muted">—</p>}
      </section>
      <section className="panel">
        <h2>Hosts</h2>
        {hosts.data?.items.map((h) => (
          <p key={h.id}>
            {h.displayName} · {h.status} · <Link href={`/hosts?id=${h.id}`}>{short(h.id)}</Link>
          </p>
        )) ?? <p className="muted">—</p>}
      </section>
      <section className="panel">
        <h2>Listings</h2>
        {assets.data?.items.map((a) => (
          <p key={a.id}>
            <Link href={`/listings/${a.id}`}>{a.title}</Link> · {a.status}
          </p>
        )) ?? <p className="muted">—</p>}
      </section>
      <section className="panel">
        <h2>Bookings</h2>
        {bookings.data?.items.map((b) => (
          <p key={b.id}>
            <Link href={`/bookings/${b.id}`}>{short(b.id)}</Link> · {b.status} · {when(b.start)}
          </p>
        )) ?? <p className="muted">Search by booking id to find bookings.</p>}
      </section>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Results />
    </Suspense>
  );
}
