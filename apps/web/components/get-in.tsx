'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatTime } from '../lib/booking';
import { FormError } from './field';

interface Access {
  status: 'ISSUED' | 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
  code: string | null;
  plate: string;
  unitLabel: string | null;
  validFrom: string;
  validUntil: string;
  enteredAt: string | null;
  canCheckIn: boolean;
  passToken: string | null;
}
export interface Issue {
  id: string;
  kind: string;
  status: 'OPEN' | 'RESOLVED_ON_SITE' | 'REFUNDED' | 'ESCALATED' | 'WITHDRAWN';
  deadlineAt: string;
  note: string | null;
}

export const ISSUE_LABEL: Record<string, string> = {
  ACCESS_DENIED: 'The guard or gate won’t let me in',
  UNIT_OCCUPIED: 'Someone else is in my space',
  CHARGER_FAULTY: 'The charger isn’t working',
  HOST_UNREACHABLE: 'I can’t reach the host',
  CANNOT_FIND: 'I can’t find the space',
};

/**
 * C-12 "Get in" and C-13 "I can't get in" (ux §5.2, §7.5, §7.6). The code is shown large; the guard checks it
 * against the plate. The recourse promise is explicit: fixed in 15 minutes or a full refund.
 */
export function GetIn({
  bookingId,
  bookingStatus,
  issue,
  onChange,
}: {
  bookingId: string;
  bookingStatus: string;
  issue: Issue | null;
  onChange: () => void;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setAccess(await apiRequest<Access>(`/api/v1/bookings/${encodeURIComponent(bookingId)}/access`));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'access.not_available'))
        setError(e instanceof ApiError ? e.userMessage : 'Could not load your access details.');
    }
  }, [bookingId]);
  useEffect(() => {
    void load();
  }, [load, bookingStatus]);

  async function act(path: string, body: object = {}, refreshBooking = true) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<Access | unknown>(
        `/api/v1/bookings/${encodeURIComponent(bookingId)}/${path}`,
        { method: 'POST', body },
      );
      if (path.startsWith('access') || path === 'check-in') setAccess(res as Access);
      if (refreshBooking) onChange();
      setReporting(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function onReport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void act('issues', {
      kind: String(f.get('kind') ?? 'ACCESS_DENIED'),
      note: String(f.get('note') ?? '').trim() || null,
    });
  }

  async function share() {
    if (!access?.passToken) return;
    const url = `${location.origin}/pass/${access.passToken}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Parking pass', url });
      else await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // the person cancelled the share sheet
    }
  }

  if (!access) return error ? <FormError message={error} /> : null;
  const a = access;
  const live = a.status === 'ACTIVE' || a.status === 'USED';
  return (
    <section className="notice" aria-labelledby="getin-h">
      <h2 id="getin-h">Get in</h2>
      {a.code && a.status !== 'EXPIRED' ? (
        <p className="pass-code" aria-label={`Access code ${a.code.split('').join(' ')}`}>
          {a.code}
        </p>
      ) : null}
      <p>
        Vehicle <strong>{a.plate}</strong>
        {a.unitLabel ? (
          <>
            {' '}
            · space <strong>{a.unitLabel}</strong>
          </>
        ) : null}
      </p>
      <p className="small muted" role="status">
        {a.status === 'ISSUED' ? `Valid from ${formatTime(a.validFrom)}. ` : null}
        {live ? `Valid until ${formatTime(a.validUntil)}. ` : null}
        {a.status === 'USED' && a.enteredAt ? `Entered at ${formatTime(a.enteredAt)}. ` : null}
        {a.status === 'EXPIRED' ? 'Booking ended.' : null}
        {a.status === 'REVOKED' ? 'Access cancelled.' : null}
        {live || a.status === 'ISSUED' ? 'Show the code or your number plate at the gate.' : null}
      </p>
      <div className="row-start">
        {a.canCheckIn && bookingStatus === 'CONFIRMED' ? (
          <button type="button" disabled={busy} onClick={() => void act('check-in')}>
            I&apos;m here
          </button>
        ) : null}
        {a.passToken ? (
          <button type="button" className="link" onClick={() => void share()}>
            {copied ? 'Pass link copied' : 'Share with driver'}
          </button>
        ) : null}
        {live || a.status === 'ISSUED' ? (
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => void act('access/reissue', {}, false)}
          >
            New code
          </button>
        ) : null}
      </div>

      {issue && issue.status === 'OPEN' ? (
        <div role="alert" className="issue">
          <p>
            <strong>Problem reported:</strong> {ISSUE_LABEL[issue.kind] ?? issue.kind}. The host has been
            asked to fix it by {formatTime(issue.deadlineAt)}. If it isn&apos;t fixed by then, you get a full
            refund automatically.
          </p>
          <div className="row-start">
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void act(`issues/${issue.id}/withdraw`)}
            >
              It&apos;s sorted now
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void act(`issues/${issue.id}/escalate`)}
            >
              Still stuck: contact support
            </button>
          </div>
        </div>
      ) : issue?.status === 'ESCALATED' ? (
        <p className="small">Support is handling your problem.</p>
      ) : live && ['CONFIRMED', 'IN_PROGRESS'].includes(bookingStatus) ? (
        reporting ? (
          <form onSubmit={onReport} noValidate aria-label="Report a problem getting in">
            <div className="field">
              <label htmlFor="issue-kind">What&apos;s wrong?</label>
              <select id="issue-kind" name="kind" defaultValue="ACCESS_DENIED">
                {Object.entries(ISSUE_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="issue-note">Details (optional)</label>
              <input id="issue-note" name="note" maxLength={500} />
            </div>
            <div className="row-start">
              <button type="submit" disabled={busy}>
                Report problem
              </button>
              <button type="button" className="link" onClick={() => setReporting(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="link" onClick={() => setReporting(true)}>
            I can&apos;t get in
          </button>
        )
      ) : null}
      <FormError message={error} />
    </section>
  );
}
