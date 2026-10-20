import type { Metadata } from 'next';
import { DisputeView } from './dispute-view';

export const metadata: Metadata = { title: 'Dispute' };

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="page medium">
      <DisputeView id={(await params).id} />
    </main>
  );
}
