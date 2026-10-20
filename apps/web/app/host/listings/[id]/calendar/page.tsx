import type { Metadata } from 'next';
import { HostCalendar } from './host-calendar';

export const metadata: Metadata = { title: 'Calendar' };

export default async function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  return <HostCalendar id={(await params).id} />;
}
