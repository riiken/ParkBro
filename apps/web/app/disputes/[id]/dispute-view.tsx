'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DISPUTE_CATEGORY, DISPUTE_STATUS } from '../../../components/booking-disputes';
import { FormError } from '../../../components/field';
import { formatDate, formatRupees, formatTime } from '../../../lib/booking';

interface Dispute {
  id: string;
  bookingId: string;
  category: string;
  risk: 'LOW' | 'HIGH';
  status: string;
  outcome: string | null;
  refundPaise: number | null;
  resolutionNote: string | null;
  you: 'CUSTOMER' | 'HOST';
  messages: { author: string; body: string; at: string }[];
  evidence: { id: string; by: string; width: number; height: number }[];
}

const OUTCOME: Record<string, string> = {
  NO_ACTION: 'No action needed',
  REFUND_FULL: 'Full refund',
  REFUND_PARTIAL: 'Partial refund',
  WARNING: 'Warning issued',
  RESTRICT_ACCOUNT: 'Account restricted',
};

/** C-18 dispute: status, timeline with ParkBro, photos. Decisions are made by people, never automatically. */
export function DisputeView({ id }: { id: string }) {
  const router = useRouter();
  const [d, setD] = useState<Dispute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setD(await apiRequest<Dispute>(`/api/v1/disputes/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return router.replace(`/sign-in?next=/disputes/${id}`);
      setError(e instanceof ApiError ? e.userMessage : 'Could not load the dispute.');
    }
  }, [id, router]);
  useEffect(() => {
    void load();
  }, [load]);

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    try {
      setD(
        await apiRequest<Dispute>(`/api/v1/disputes/${encodeURIComponent(id)}/messages`, {
          method: 'POST',
          body: { body: String(new FormData(form).get('body') ?? '') },
        }),
      );
      form.reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : 'Could not send.');
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/disputes/${encodeURIComponent(id)}/evidence`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'fetch', 'content-type': file.type },
      body: file,
    });
    if (!res.ok)
      setError(((await res.json().catch(() => ({}))) as { title?: string }).title ?? 'Upload failed.');
    setBusy(false);
    await load();
  }

  if (error && !d) return <FormError message={error} />;
  if (!d) return <p aria-busy="true">Loading…</p>;
  const open = d.status !== 'RESOLVED' && d.status !== 'CLOSED';
  return (
    <div>
      <p>
        <Link href={d.you === 'HOST' ? `/host/bookings/${d.bookingId}` : `/bookings/${d.bookingId}`}>
          ← Booking
        </Link>
      </p>
      <h1>{DISPUTE_CATEGORY[d.category] ?? d.category}</h1>
      <p>
        <span className="status">{DISPUTE_STATUS[d.status] ?? d.status}</span>
        {d.risk === 'HIGH' ? <span className="small muted"> · handled by trust &amp; safety</span> : null}
      </p>
      {d.outcome ? (
        <p className="notice">
          Decision: {OUTCOME[d.outcome] ?? d.outcome}
          {d.refundPaise ? ` (${formatRupees(d.refundPaise)} refunded)` : ''}. {d.resolutionNote}
        </p>
      ) : null}
      <h2>Timeline</h2>
      <ul className="list">
        {d.messages.map((m, i) => (
          <li key={i}>
            <span>
              <strong>
                {m.author === d.you
                  ? 'You'
                  : m.author === 'ADMIN'
                    ? 'ParkBro'
                    : m.author === 'HOST'
                      ? 'Host'
                      : 'Customer'}
              </strong>
              <br />
              {m.body}
            </span>
            <span className="small muted">
              {formatDate(m.at)} {formatTime(m.at)}
            </span>
          </li>
        ))}
      </ul>
      {d.evidence.length ? (
        <>
          <h2>Photos</h2>
          <ul className="thumbs">
            {d.evidence.map((e) => (
              <li key={e.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- private evidence, see D-098 */}
                <img
                  src={`/api/v1/dispute-evidence/${e.id}`}
                  alt={`Evidence from ${e.by.toLowerCase()}`}
                  width={e.width}
                  height={e.height}
                  loading="lazy"
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {open ? (
        <>
          <form onSubmit={send} noValidate aria-label="Add to the dispute">
            <div className="field">
              <label htmlFor="msg">Add a message</label>
              <textarea id="msg" name="body" rows={3} maxLength={2000} required />
            </div>
            <button type="submit" disabled={busy}>
              Send
            </button>
          </form>
          <div className="field">
            <label htmlFor="evidence">Add a photo (location data is removed)</label>
            <input
              id="evidence"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </div>
        </>
      ) : null}
      <FormError message={error} />
    </div>
  );
}
