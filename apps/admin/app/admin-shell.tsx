'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useEffect, useState, type ReactNode } from 'react';

const NAV: [group: string, links: [string, string][]][] = [
  [
    'Overview',
    [
      ['/', 'Dashboard'],
      ['/search', 'Search'],
      ['/analytics', 'Analytics'],
    ],
  ],
  [
    'People',
    [
      ['/users', 'Users'],
      ['/hosts', 'Hosts'],
    ],
  ],
  [
    'Marketplace',
    [
      ['/properties', 'Properties'],
      ['/listings', 'Listings'],
      ['/bookings', 'Bookings'],
      ['/reviews', 'Reviews'],
      ['/disputes', 'Disputes'],
    ],
  ],
  [
    'Money',
    [
      ['/payments', 'Payments'],
      ['/payouts', 'Payouts'],
    ],
  ],
  [
    'Trust & compliance',
    [
      ['/fraud', 'Fraud'],
      ['/data-requests', 'Data requests'],
      ['/audit', 'Audit log'],
      ['/config', 'Config'],
    ],
  ],
];

/** Admin console frame (ux §3.6): navigation and session; every screen's data is permission-checked by the API. */
export function AdminShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<{ displayName: string; permissions: string[] } | null>(null);
  useEffect(() => {
    if (path === '/sign-in') return;
    apiRequest<{ displayName: string; permissions: string[] }>('/api/admin/me')
      .then(setMe)
      .catch(() => router.replace('/sign-in'));
  }, [path, router]);
  if (path === '/sign-in') return <>{children}</>; // the sign-in page is its own card
  return (
    <div className="shell">
      <nav aria-label="Admin" className="side">
        {NAV.map(([group, links]) => (
          <Fragment key={group}>
            <span className="nav-group" aria-hidden="true">
              {group}
            </span>
            {links.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={path === href || (href !== '/' && path.startsWith(href)) ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </Fragment>
        ))}
        {me ? (
          <div className="me">
            <span>{me.displayName}</span>
            <span className="muted small">{me.permissions.join(', ')}</span>
            <button
              type="button"
              className="link"
              onClick={() =>
                void apiRequest('/api/admin/auth/logout', { method: 'POST' }).then(() =>
                  router.replace('/sign-in'),
                )
              }
            >
              Sign out
            </button>
          </div>
        ) : null}
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}
