import type { ReactNode } from 'react';
import { HostNav } from '../../components/site-nav';

/** Hosting mode (ux-architecture §3.3). */
export default function HostLayout({ children }: { children: ReactNode }) {
  return (
    <main className="page wide host">
      <HostNav />
      {children}
    </main>
  );
}
