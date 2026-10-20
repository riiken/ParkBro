import type { Metadata } from 'next';
import { BookingsList } from './bookings-list';

export const metadata: Metadata = { title: 'Your bookings' };

export default function BookingsPage() {
  return (
    <main className="page medium">
      <h1>Your bookings</h1>
      <BookingsList />
    </main>
  );
}
