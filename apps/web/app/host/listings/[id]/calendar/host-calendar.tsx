'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { FormError } from '../../../../../components/field';
import { HostGate } from '../../../../../components/host-gate';
import { addDays, formatTime, localToIso, todayLocal } from '../../../../../lib/booking';

interface Calendar {
  timezone: string;
  units: { id: string; label: string; free: { start: string; end: string }[] }[];
  exceptions: {
    id: string;
    unitId: string | null;
    kind: 'BLOCK' | 'OPEN';
    start: string;
    end: string;
    reason: string | null;
  }[];
  reservations: { unitId: string; start: string; end: string }[];
}
type Segment = {
  kind: 'free' | 'booked' | 'blocked';
  start: string;
  end: string;
  label: string;
  exceptionId?: string;
};

/**
 * H-05 calendar: one day per space with free time, bookings (read-only) and blocks. Blocking time that is already
 * booked is refused by the server ("cancel the booking instead", BR-04).
 */
export function HostCalendar({ id }: { id: string }) {
  return <HostGate>{(account) => <Cal id={id} canWrite={account.status === 'ACTIVE'} />}</HostGate>;
}

function Cal({ id, canWrite }: { id: string; canWrite: boolean }) {
  const [day, setDay] = useState(todayLocal());
  const [cal, setCal] = useState<Calendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the latest request may update the view: switching days quickly must never show a stale day.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setError(null);
    try {
      const from = encodeURIComponent(localToIso(day, '00:00'));
      const to = encodeURIComponent(localToIso(addDays(day, 1), '00:00'));
      const result = await apiRequest<Calendar>(
        `/api/v1/host/assets/${encodeURIComponent(id)}/calendar?from=${from}&to=${to}`,
      );
      if (ticket === latest.current) setCal(result);
    } catch (e) {
      if (ticket !== latest.current) return;
      setError(e instanceof ApiError ? e.userMessage : 'Could not load the calendar.');
    }
  }, [id, day]);
  useEffect(() => {
    void load();
  }, [load]);

  async function addBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const date = String(f.get('date') ?? day);
    const from = String(f.get('from') ?? '00:00');
    const to = String(f.get('to') ?? '00:00');
    setBusy(true);
    setFormError(null);
    try {
      await apiRequest(`/api/v1/host/assets/${encodeURIComponent(id)}/availability-exceptions`, {
        method: 'POST',
        body: {
          kind: 'BLOCK',
          start: localToIso(date, from),
          end: localToIso(to <= from ? addDays(date, 1) : date, to),
          unitId: String(f.get('unitId') || '') || null,
          reason: String(f.get('reason') ?? '').trim() || null,
        },
      });
      setDay(date);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.userMessage : 'Could not block that time.');
    } finally {
      setBusy(false);
    }
  }

  async function removeBlock(exceptionId: string) {
    setFormError(null);
    try {
      await apiRequest(
        `/api/v1/host/assets/${encodeURIComponent(id)}/availability-exceptions/${exceptionId}`,
        { method: 'DELETE' },
      );
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.userMessage : 'Could not remove the block.');
    }
  }

  function segments(unitId: string): Segment[] {
    if (!cal) return [];
    const unit = cal.units.find((u) => u.id === unitId);
    const out: Segment[] = [
      ...(unit?.free ?? []).map((i) => ({ kind: 'free' as const, ...i, label: 'Free' })),
      ...cal.reservations
        .filter((r) => r.unitId === unitId)
        .map((r) => ({
          kind: 'booked' as const,
          start: r.start,
          end: r.end,
          label: 'Booked (incl. turnover gap)',
        })),
      ...cal.exceptions
        .filter((e) => e.kind === 'BLOCK' && (e.unitId === null || e.unitId === unitId))
        .map((e) => ({
          kind: 'blocked' as const,
          start: e.start,
          end: e.end,
          label: `Blocked${e.reason ? `: ${e.reason}` : ''}`,
          exceptionId: e.id,
        })),
    ];
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }

  const range = (s: Segment) => `${formatTime(s.start)} – ${formatTime(s.end)}`;
  return (
    <div>
      <p>
        <Link href={`/host/listings/${id}`}>← Listing</Link>
      </p>
      <h1>Calendar</h1>
      <div className="row-start">
        <button type="button" className="link" onClick={() => setDay(addDays(day, -1))}>
          ← Previous day
        </button>
        <div className="field">
          <label htmlFor="cal-day">Day</label>
          <input
            id="cal-day"
            type="date"
            value={day}
            onChange={(e) => e.target.value && setDay(e.target.value)}
          />
        </div>
        <button type="button" className="link" onClick={() => setDay(addDays(day, 1))}>
          Next day →
        </button>
      </div>
      <FormError message={error} />
      {!cal ? (
        <p aria-busy="true">Loading…</p>
      ) : (
        cal.units.map((u) => (
          <section key={u.id} aria-label={`Space ${u.label}`}>
            <h2>Space {u.label}</h2>
            {segments(u.id).length === 0 ? (
              <p className="muted">Closed all day (outside your weekly schedule).</p>
            ) : (
              <ul className="timeline">
                {segments(u.id).map((s, i) => (
                  <li key={`${s.kind}-${i}`} className={s.kind}>
                    {range(s)} · {s.label}{' '}
                    {s.exceptionId && canWrite ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => void removeBlock(s.exceptionId ?? '')}
                      >
                        Remove block
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}

      {canWrite && cal ? (
        <form onSubmit={addBlock} noValidate className="section" aria-label="Block time">
          <h2>Block time</h2>
          <div className="field">
            <label htmlFor="b-date">Date</label>
            <input id="b-date" name="date" type="date" min={todayLocal()} defaultValue={day} key={day} />
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="b-from">From</label>
              <input id="b-from" name="from" type="time" step={900} defaultValue="09:00" />
            </div>
            <div className="field">
              <label htmlFor="b-to">Until</label>
              <input id="b-to" name="to" type="time" step={900} defaultValue="18:00" />
            </div>
          </div>
          {cal.units.length > 1 ? (
            <div className="field">
              <label htmlFor="b-unit">Space</label>
              <select id="b-unit" name="unitId" defaultValue="">
                <option value="">All spaces</option>
                {cal.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="b-reason">Note (only you see it)</label>
            <input id="b-reason" name="reason" maxLength={200} />
          </div>
          <FormError message={formError} />
          <button type="submit" disabled={busy}>
            {busy ? 'Blocking…' : 'Block'}
          </button>
        </form>
      ) : null}
    </div>
  );
}
