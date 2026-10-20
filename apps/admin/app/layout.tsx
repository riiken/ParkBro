import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { AdminShell } from './admin-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'ParkBro Admin',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection(); // per-request rendering for the CSP nonce
  return (
    <html lang="en">
      <body>
        <header className="admin-header">
          <span className="logo" aria-hidden="true">
            P
          </span>
          ParkBro Admin
          <span className="env">Operations console</span>
        </header>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
