import type { Metadata } from 'next';
import { HostListings } from './host-listings';

export const metadata: Metadata = { title: 'Your listings' };

export default function HostListingsPage() {
  return <HostListings />;
}
