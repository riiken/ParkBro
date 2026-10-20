import type { Metadata } from 'next';
import { GuardView } from './guard-view';

export const metadata: Metadata = { title: 'Gate check', robots: { index: false, follow: false } };

export default async function GatePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <main className="page">
      <GuardView token={(await params).token} />
    </main>
  );
}
