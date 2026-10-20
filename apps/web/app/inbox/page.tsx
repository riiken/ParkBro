import type { Metadata } from 'next';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Notifications' };

export default function InboxPage() {
  return (
    <main className="page medium">
      <InboxView />
    </main>
  );
}
