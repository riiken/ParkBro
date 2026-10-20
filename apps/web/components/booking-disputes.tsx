'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FormError } from './field';

export const DISPUTE_CATEGORY: Record<string, string> = {
  UNAVAILABLE_ASSET: 'The space wasn’t available',
  INCORRECT_LISTING: 'The listing was wrong',
  ACCESS_FAILURE: 'Couldn’t get in',
  DAMAGE: 'Damage (vehicle or property)',
  CHARGING_FAILURE: 'Charging didn’t work',
  BILLING: 'Billing or refund',
  NO_SHOW: 'No-show',
  CANCELLATION: 'Cancellation',
  MISCONDUCT: 'Behaviour or safety',
};
export const DISPUTE_STATUS: Record<string, string> = {
  OPEN: 'Received',
  UNDER_REVIEW: 'Being reviewed',
  AWAITING_INFO: 'We need more information',
  ESCALATED: 'With a senior specialist',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

interface Dispute {
  id: string;
  category: string;
  status: string;
  openedBy: 'CUSTOMER' | 'HOST';
  createdAt: string;
}

/** Entry to disputes from a booking (C-18): list existing ones and open a new one. */
export function BookingDisputes({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [list, setList] = useState<Dispute[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await apiRequest<Dispute[]>(`/api/v1/bookings/${encodeURIComponent(bookingId)}/disputes`));
    } catch {
      setList(null);
    }
  }, [bookingId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    try {
      const d = await apiRequest<{ id: string }>(
        `/api/v1/bookings/${encodeURIComponent(bookingId)}/disputes`,
        {
          method: 'POST',
          body: {
            category: String(f.get('category')),
            description: String(f.get('description') ?? ''),
            requestedOutcome: String(f.get('outcome')),
          },
        },
      );
      router.push(`/disputes/${d.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : 'Could not open the dispute.');
    }
  }

  if (!list) return null;
  return (
    <section className="section" aria-labelledby="disputes-h">
      <h2 id="disputes-h">Problems after the booking</h2>
      {list.map((d) => (
        <p key={d.id}>
          <Link href={`/disputes/${d.id}`}>{DISPUTE_CATEGORY[d.category] ?? d.category}</Link> ·{' '}
          {DISPUTE_STATUS[d.status] ?? d.status}
        </p>
      ))}
      {opening ? (
        <form onSubmit={submit} noValidate aria-label="Open a dispute">
          <div className="field">
            <label htmlFor="d-category">What happened?</label>
            <select id="d-category" name="category" defaultValue="INCORRECT_LISTING">
              {Object.entries(DISPUTE_CATEGORY).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="d-description">Describe it</label>
            <textarea id="d-description" name="description" rows={4} maxLength={2000} required />
          </div>
          <div className="field">
            <label htmlFor="d-outcome">What would put it right?</label>
            <select id="d-outcome" name="outcome" defaultValue="REFUND">
              <option value="REFUND">A refund</option>
              <option value="PARTIAL_REFUND">A partial refund</option>
              <option value="COMPENSATION">Compensation for damage</option>
              <option value="REVIEW_ONLY">Just look into it</option>
              <option value="OTHER">Something else</option>
            </select>
          </div>
          <p className="small muted">
            Our team reviews every dispute. You can add photos on the next screen. Damage and safety cases go
            to trust &amp; safety.
          </p>
          <FormError message={error} />
          <button type="submit">Open dispute</button>
        </form>
      ) : (
        <button type="button" className="link" onClick={() => setOpening(true)}>
          Report a problem with this booking
        </button>
      )}
    </section>
  );
}
