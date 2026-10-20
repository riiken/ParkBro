import type { Metadata } from 'next';
import { BookingDetail } from './booking-detail';

export const metadata: Metadata = { title: 'Booking' };

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <main className="page medium">
      <BookingDetail id={(await params).id} />
    </main>
  );
}
