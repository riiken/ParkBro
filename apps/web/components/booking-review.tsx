'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatDate } from '../lib/booking';
import { FormError } from './field';

interface Review {
  rating: number;
  dimensions: Record<string, number>;
  body: string | null;
  status: 'SUBMITTED' | 'PUBLISHED' | 'REMOVED';
}
interface State {
  canReview: boolean;
  windowEndsAt: string;
  mine: Review | null;
  theirs: Review | null;
}

const DIMS: Record<string, string> = {
  accuracy: 'As described',
  access: 'Getting in',
  safety: 'Safety',
  communication: 'Communication',
};
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/** C-17 / host review (domain-model §5.10): blind until both sides review or the window closes. */
export function BookingReview({ bookingId, as }: { bookingId: string; as: 'CUSTOMER' | 'HOST' }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setState(await apiRequest<State>(`/api/v1/bookings/${encodeURIComponent(bookingId)}/review`));
    } catch {
      setState(null);
    }
  }, [bookingId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const dimensions = Object.fromEntries(
        Object.keys(DIMS).flatMap((d) => (f.get(d) ? [[d, Number(f.get(d))]] : [])),
      );
      setState(
        await apiRequest<State>(`/api/v1/bookings/${encodeURIComponent(bookingId)}/review`, {
          method: 'POST',
          body: {
            rating: Number(f.get('rating') ?? 5),
            dimensions: as === 'CUSTOMER' ? dimensions : {},
            body: String(f.get('body') ?? '').trim() || null,
          },
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : 'Could not save the review.');
    } finally {
      setBusy(false);
    }
  }

  if (!state || (!state.canReview && !state.mine && !state.theirs)) return null;
  const who = as === 'CUSTOMER' ? 'the host' : 'the customer';
  return (
    <section className="section" aria-labelledby="review-h">
      <h2 id="review-h">Review</h2>
      {state.canReview ? (
        <form onSubmit={submit} noValidate aria-label="Leave a review">
          <div className="field">
            <label htmlFor="rating">
              {as === 'CUSTOMER' ? 'How was the space?' : 'How was the customer?'}
            </label>
            <select id="rating" name="rating" defaultValue="5">
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {stars(n)} ({n})
                </option>
              ))}
            </select>
          </div>
          {as === 'CUSTOMER'
            ? Object.entries(DIMS).map(([k, label]) => (
                <div className="field" key={k}>
                  <label htmlFor={`dim-${k}`}>{label} (optional)</label>
                  <select id={`dim-${k}`} name={k} defaultValue="">
                    <option value="">—</option>
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              ))
            : null}
          <div className="field">
            <label htmlFor="review-body">Comment (optional, public)</label>
            <textarea id="review-body" name="body" rows={3} maxLength={1000} />
          </div>
          <p className="small muted">
            Your review stays hidden until {who} also reviews, or until {formatDate(state.windowEndsAt)}.
          </p>
          <FormError message={error} />
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Submit review'}
          </button>
        </form>
      ) : null}
      {state.mine ? (
        <p>
          You rated {stars(state.mine.rating)}
          {state.mine.status === 'SUBMITTED' ? ' · hidden until both reviews are in' : ''}
        </p>
      ) : null}
      {state.theirs ? (
        <p>
          {as === 'CUSTOMER' ? 'The host' : 'The customer'} rated you {stars(state.theirs.rating)}
          {state.theirs.body ? `: “${state.theirs.body}”` : ''}
        </p>
      ) : null}
    </section>
  );
}
