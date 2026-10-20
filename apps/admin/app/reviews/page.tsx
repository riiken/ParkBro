'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { PagedList, ReasonAction, short, when } from '../../lib/admin';

interface R {
  id: string;
  bookingId: string;
  assetId: string;
  authorKind: string;
  rating: number;
  body: string | null;
  status: string;
  createdAt: string;
}

export default function ReviewsPage() {
  return (
    <div>
      <h1>Reviews</h1>
      <PagedList<R>
        base="/api/admin/v1/reviews"
        filters={[
          {
            name: 'status',
            label: 'Status',
            options: [
              ['SUBMITTED', 'Hidden (blind)'],
              ['PUBLISHED', 'Published'],
              ['REMOVED', 'Removed'],
            ],
          },
          {
            name: 'authorKind',
            label: 'Author',
            options: [
              ['CUSTOMER', 'Customer'],
              ['HOST', 'Host'],
            ],
          },
        ]}
        rowKey={(r) => r.id}
        columns={[
          { label: 'When', render: (r) => when(r.createdAt) },
          { label: 'By', render: (r) => r.authorKind },
          { label: 'Rating', render: (r) => '★'.repeat(r.rating) },
          { label: 'Text', render: (r) => r.body ?? '' },
          {
            label: 'Booking',
            render: (r) => <Link href={`/bookings/${r.bookingId}`}>{short(r.bookingId)}</Link>,
          },
          { label: 'Status', render: (r) => r.status },
          {
            label: 'Moderate',
            render: (r) =>
              r.status !== 'REMOVED' ? (
                <ReasonAction
                  label="Remove"
                  danger
                  run={(reason) =>
                    apiRequest(`/api/admin/v1/reviews/${r.id}/remove`, { method: 'POST', body: { reason } })
                  }
                />
              ) : null,
          },
        ]}
      />
    </div>
  );
}
