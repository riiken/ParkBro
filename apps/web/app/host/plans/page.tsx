import type { Metadata } from 'next';
import { HostPlans } from './host-plans';

export const metadata: Metadata = { title: 'Monthly plans' };

export default function HostPlansPage() {
  return <HostPlans />;
}
