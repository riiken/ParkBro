import type { Metadata } from 'next';
import { HostBookings } from './host-bookings';

export const metadata: Metadata = { title: 'Bookings' };

export default function HostBookingsPage() {
  return <HostBookings />;
}
