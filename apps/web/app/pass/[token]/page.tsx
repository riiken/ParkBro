import type { Metadata } from 'next';
import { PassView } from './pass-view';

export const metadata: Metadata = { title: 'Parking pass', robots: { index: false, follow: false } };

export default async function PassPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <main className="page narrow">
      <PassView token={(await params).token} />
    </main>
  );
}
