'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApi, type Page } from '../lib/admin';

/** Work queues at a glance (ux §3.6). Each count links to its queue; the API checks permissions per call. */
export default function Dashboard() {
  const router = useRouter();
  const me = useApi<{ displayName: string }>('/api/admin/me');
  const review = useApi<unknown[]>('/api/admin/review/assets');
  const disputes = useApi<{ risk: string }[]>('/api/admin/v1/disputes');
  const recon = useApi<unknown[]>('/api/admin/v1/payments/reconciliation');
  const accounts = useApi<unknown[]>('/api/admin/v1/payout-accounts/pending');
  const payouts = useApi<unknown[]>('/api/admin/v1/payouts/open');
  const fraud = useApi<unknown[]>('/api/admin/v1/fraud-indicators');
  const users = useApi<Page<unknown>>('/api/admin/v1/users?limit=1');
  const bookings = useApi<Page<unknown>>('/api/admin/v1/bookings?status=CONFIRMED&limit=1');
  const ops = useApi<{
    status: 'ok' | 'warn' | 'critical';
    checks: { name: string; area: string; value: number; status: string; meaning: string }[];
  }>('/api/admin/v1/ops/health');
  const problems = ops.data?.checks.filter((c) => c.status === 'warn' || c.status === 'critical') ?? [];
  const n = (x: { data: unknown[] | null; error: string | null }) =>
    x.error ? '—' : x.data ? x.data.length : '…';
  const cards: [string, string, string | number][] = [
    ['/listings', 'Listings to review', n(review)],
    ['/disputes', 'Open disputes', n(disputes)],
    [
      '/disputes',
      'High-risk disputes',
      disputes.data ? disputes.data.filter((d) => d.risk === 'HIGH').length : '—',
    ],
    ['/payments', 'Reconciliation items', n(recon)],
    ['/payouts', 'Payout accounts to verify', n(accounts)],
    ['/payouts', 'Payouts to send', n(payouts)],
    ['/fraud', 'Fraud indicators', n(fraud)],
    ['/users', 'Users', users.data?.total ?? '—'],
    ['/bookings', 'Confirmed bookings', bookings.data?.total ?? '—'],
  ];
  return (
    <div>
      <h1>Dashboard</h1>
      {me.data ? <p className="muted">Signed in as {me.data.displayName}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
          if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
        }}
        className="filters"
        role="search"
      >
        <label>
          Search users, hosts, listings, bookings
          <input name="q" placeholder="Phone, name, title or booking id" />
        </label>
        <button type="submit">Search</button>
      </form>
      <div className="cards">
        {cards.map(([href, label, value]) => (
          <Link key={label} href={href} className="card">
            <strong>{value}</strong>
            {label}
          </Link>
        ))}
      </div>
      <p className="small muted">A dash means your permissions don&apos;t include that queue.</p>

      <h2>Operations</h2>
      {ops.error ? (
        <p className="error" role="alert">
          {ops.error} <button onClick={() => void ops.reload()}>Retry</button>
        </p>
      ) : !ops.data ? (
        <p className="muted">Loading…</p>
      ) : problems.length === 0 ? (
        <p>All operational checks are healthy.</p>
      ) : (
        <ul className="ops">
          {problems.map((c) => (
            <li key={c.name} className={c.status === 'critical' ? 'error' : undefined}>
              <strong>
                {c.status === 'critical' ? 'Critical' : 'Warning'} · {c.area}: {c.value}
              </strong>{' '}
              {c.meaning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
