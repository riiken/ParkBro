import type { Metadata } from 'next';
import { PlanDetail } from '../../../../components/plan-detail';

export const metadata: Metadata = { title: 'Monthly plan' };

export default async function HostPlanPage({ params }: { params: Promise<{ id: string }> }) {
  return <PlanDetail id={(await params).id} as="HOST" />;
}
