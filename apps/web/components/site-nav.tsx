'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarIcon, HomeIcon, InboxIcon, SearchIcon, UserIcon } from './icons';

const ITEMS = [
  { href: '/search', label: 'Search', Icon: SearchIcon },
  { href: '/bookings', label: 'Bookings', Icon: CalendarIcon },
  { href: '/host', label: 'Host', Icon: HomeIcon },
  { href: '/inbox', label: 'Inbox', Icon: InboxIcon },
  { href: '/account', label: 'Account', Icon: UserIcon },
] as const;

/**
 * Main navigation: inline in the header on wide screens, a bottom tab bar on phones (one nav element, restyled by
 * CSS, so every link exists once for assistive technology).
 */
export function SiteNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="nav">
      {ITEMS.map(({ href, label, Icon }) => {
        const current = path === href || path.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined} className="nav-item">
            <Icon size={22} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const HOST_ITEMS = [
  ['/host', 'Today'],
  ['/host/listings', 'Listings'],
  ['/host/bookings', 'Bookings'],
  ['/host/plans', 'Monthly plans'],
  ['/host/earnings', 'Earnings'],
  ['/host/gates', 'Gates'],
] as const;

/** Hosting mode tabs (ux-architecture §3.3): scrollable pills on phones. */
export function HostNav() {
  const path = usePathname();
  return (
    <nav aria-label="Hosting" className="subnav">
      {HOST_ITEMS.map(([href, label]) => {
        const current = href === '/host' ? path === '/host' : path === href || path.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
