import type { Metadata } from 'next';
import { PlanDetail } from '../../../../components/plan-detail';

export const metadata: Metadata = { title: 'Monthly plan' };

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="page medium">
      <PlanDetail id={(await params).id} as="CUSTOMER" />
    </main>
  );
}
