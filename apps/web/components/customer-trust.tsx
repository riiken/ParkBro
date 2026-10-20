'use client';

import { apiRequest } from '@parkbro/web-kit';
import { useEffect, useState } from 'react';

interface Trust {
  phoneVerified: boolean;
  completedBookings: number;
  noShows: number;
  hostRating: number | null;
  hostRatingCount: number;
}

/** H-06: what a host may know about a customer before deciding (verification, history, ratings; no contact data). */
export function CustomerTrust({ bookingId }: { bookingId: string }) {
  const [t, setT] = useState<Trust | null>(null);
  useEffect(() => {
    apiRequest<Trust>(`/api/v1/host/bookings/${encodeURIComponent(bookingId)}/customer-trust`)
      .then(setT)
      .catch(() => setT(null));
  }, [bookingId]);
  if (!t) return null;
  return (
    <p className="small" aria-label="About this customer">
      {t.phoneVerified ? 'Phone verified' : 'Phone not verified'} · {t.completedBookings} completed booking
      {t.completedBookings === 1 ? '' : 's'}
      {t.noShows ? ` · ${t.noShows} no-show${t.noShows === 1 ? '' : 's'}` : ''}
      {t.hostRating !== null
        ? ` · rated ${t.hostRating}/5 by hosts (${t.hostRatingCount})`
        : t.completedBookings === 0
          ? ' · new to ParkBro'
          : ''}
    </p>
  );
}
