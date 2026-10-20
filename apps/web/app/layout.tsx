import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { LogoMark } from '../components/icons';
import { SiteNav } from '../components/site-nav';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ParkBro', template: '%s · ParkBro' },
  description: 'Private parking and EV charging near you.',
  applicationName: 'ParkBro',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fc' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0e17' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request so it carries the CSP nonce (proxy.ts).
  await connection();
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {process.env.PARKBRO_STAGING === 'true' ? (
          <p className="staging-banner" role="note">
            Test environment · no real bookings, payments or messages
          </p>
        ) : null}
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand" aria-label="ParkBro home">
              <LogoMark />
              <span>ParkBro</span>
            </Link>
            <SiteNav />
          </div>
        </header>
        <div id="main" className="site-main">
          {children}
        </div>
        <footer className="site-footer">
          <div className="site-footer-inner">
            <span className="brand small">
              <LogoMark size={20} />
              <span>ParkBro</span>
            </span>
            <span className="muted small">Private parking and EV charging, Bengaluru pilot</span>
            <nav aria-label="Legal" className="footer-links small">
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
