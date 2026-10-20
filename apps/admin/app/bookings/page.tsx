'use client';

import Link from 'next/link';
import { money, PagedList, short, when } from '../../lib/admin';

interface B {
  id: string;
  status: string;
  mode: string;
  assetType: string;
  customerId: string;
  totalPaise: number;
  start: string;
  createdAt: string;
}
const STATUSES: [string, string][] = [
  'AWAITING_HOST_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'DECLINED',
  'NO_SHOW',
].map((s) => [s, s]);

export default function BookingsPage() {
  return (
    <div>
      <h1>Bookings</h1>
      <PagedList<B>
        base="/api/admin/v1/bookings"
        filters={[
          { name: 'q', label: 'Booking id (start)' },
          { name: 'status', label: 'Status', options: STATUSES },
          { name: 'from', label: 'From (YYYY-MM-DD)' },
          { name: 'to', label: 'To (YYYY-MM-DD)' },
        ]}
        rowKey={(b) => b.id}
        columns={[
          { label: 'Booking', render: (b) => <Link href={`/bookings/${b.id}`}>{short(b.id)}</Link> },
          { label: 'Status', render: (b) => b.status },
          { label: 'Type', render: (b) => `${b.assetType} · ${b.mode}` },
          { label: 'Start', render: (b) => when(b.start) },
          { label: 'Total', render: (b) => money(b.totalPaise) },
          {
            label: 'Customer',
            render: (b) => <Link href={`/users/${b.customerId}`}>{short(b.customerId)}</Link>,
          },
        ]}
      />
    </div>
  );
}
