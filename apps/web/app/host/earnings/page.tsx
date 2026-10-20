import type { Metadata } from 'next';
import { HostEarnings } from './host-earnings';

export const metadata: Metadata = { title: 'Earnings' };

export default function HostEarningsPage() {
  return <HostEarnings />;
}
