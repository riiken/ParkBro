import type { Metadata } from 'next';
import { HostBookingDetail } from './host-booking-detail';

export const metadata: Metadata = { title: 'Booking' };

export default async function HostBookingPage({ params }: { params: Promise<{ id: string }> }) {
  return <HostBookingDetail id={(await params).id} />;
}
