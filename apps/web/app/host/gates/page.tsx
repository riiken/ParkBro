import type { Metadata } from 'next';
import { HostGates } from './host-gates';

export const metadata: Metadata = { title: 'Gates and access log' };

export default function HostGatesPage() {
  return <HostGates />;
}
