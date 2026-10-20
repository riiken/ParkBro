import type { Metadata } from 'next';
import { HostToday } from './host-today';

export const metadata: Metadata = { title: 'Hosting' };

export default function HostPage() {
  return <HostToday />;
}
