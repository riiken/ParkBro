'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatTime } from '../lib/booking';
import { CONNECTOR_LABEL } from '../lib/format';
import { FormError } from './field';

interface Session {
  status: 'NOT_STARTED' | 'CHARGING' | 'COMPLETED' | 'STOPPED_EARLY' | 'FAULTED';
  charger: {
    connectors: string[];
    currentType: 'AC' | 'DC';
    powerKw: number;
    speed: 'SLOW' | 'FAST' | 'RAPID';
    cableProvided: boolean;
  };
  startedAt: string | null;
  endedAt: string | null;
  energyKwh: number | null;
  metering: string;
  maxEnergyKwhForBooking: number;
  fault: { reason: string; note: string | null } | null;
  actions: { canStart: boolean; canStop: boolean; canReportFault: boolean };
}

export const SPEED_LABEL = {
  SLOW: 'Slow charging',
  FAST: 'Fast AC charging',
  RAPID: 'Rapid DC charging',
} as const;
const FAULTS: Record<string, string> = {
  NOT_WORKING: "Charger isn't working",
  CONNECTOR_DAMAGED: 'Connector or cable damaged',
  NO_POWER: 'No power',
  CANNOT_REACH: "Can't reach the charger (bay blocked)",
  OTHER: 'Something else',
};

/**
 * C-20 EV session panel (ux §7.7). Start and stop are self-reported until a smart charger is connected (D-005);
 * the server enforces the booking window and records every step.
 */
export function ChargingPanel({ bookingId, host = false }: { bookingId: string; host?: boolean }) {
  const base = `/api/v1/${host ? 'host/' : ''}bookings/${encodeURIComponent(bookingId)}/charging`;
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      setSession(await apiRequest<Session>(base));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'charging.not_an_ev_booking' || e.status === 404))
        setHidden(true);
      else setError(e instanceof ApiError ? e.userMessage : 'Could not load the charging session.');
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(path: string, body: object = {}) {
    setBusy(true);
    setError(null);
    try {
      setSession(await apiRequest<Session>(`${base}/${path}`, { method: 'POST', body }));
      setReporting(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function onFault(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void act('fault', {
      reason: String(f.get('reason') ?? 'NOT_WORKING'),
      note: String(f.get('note') ?? '').trim() || null,
    });
  }

  if (hidden) return null;
  if (!session) return error ? <FormError message={error} /> : <p aria-busy="true">Loading charger…</p>;
  const s = session;
  const c = s.charger;
  return (
    <section className="notice" aria-labelledby="charging-h">
      <h2 id="charging-h">Charging</h2>
      <p className="small">
        {SPEED_LABEL[c.speed]} · {c.currentType} {c.powerKw} kW ·{' '}
        {c.connectors.map((x) => CONNECTOR_LABEL[x] ?? x).join(', ')} ·{' '}
        {c.cableProvided ? 'cable provided' : 'bring your cable'}
      </p>
      <p role="status">
        {s.status === 'NOT_STARTED' ? (host ? 'Not started yet.' : 'Plug in, then tap Start.') : null}
        {s.status === 'CHARGING' && s.startedAt ? `Charging since ${formatTime(s.startedAt)}.` : null}
        {s.status === 'COMPLETED' && s.endedAt ? `Done at ${formatTime(s.endedAt)}.` : null}
        {s.status === 'STOPPED_EARLY' && s.endedAt ? `Stopped at ${formatTime(s.endedAt)}.` : null}
        {s.status === 'FAULTED'
          ? `Problem reported: ${FAULTS[s.fault?.reason ?? 'OTHER'] ?? 'charger fault'}.`
          : null}
        {s.energyKwh !== null ? ` ${s.energyKwh} kWh delivered.` : ''}
      </p>
      {s.status === 'NOT_STARTED' && !host ? (
        <p className="small muted">
          Up to about {s.maxEnergyKwhForBooking} kWh in your booking at this charger&apos;s rated power. Your
          car may charge slower. This is an estimate, not a promise.
        </p>
      ) : null}
      <FormError message={error} />
      {!host ? (
        <div className="row-start">
          {s.actions.canStart ? (
            <button type="button" disabled={busy} onClick={() => void act('start')}>
              Start charging
            </button>
          ) : null}
          {s.actions.canStop ? (
            <button type="button" disabled={busy} onClick={() => void act('stop')}>
              Stop charging
            </button>
          ) : null}
          {s.actions.canReportFault && !reporting ? (
            <button type="button" className="link" onClick={() => setReporting(true)}>
              Charger not working?
            </button>
          ) : null}
        </div>
      ) : null}
      {reporting ? (
        <form onSubmit={onFault} noValidate aria-label="Report a charger problem">
          <div className="field">
            <label htmlFor="fault-reason">What&apos;s wrong?</label>
            <select id="fault-reason" name="reason" defaultValue="NOT_WORKING">
              {Object.entries(FAULTS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="fault-note">Details (optional)</label>
            <input id="fault-note" name="note" maxLength={500} />
          </div>
          <div className="row-start">
            <button type="submit" disabled={busy}>
              Report problem
            </button>
            <button type="button" className="link" onClick={() => setReporting(false)}>
              Cancel
            </button>
          </div>
          <p className="small muted">
            We record the problem with your booking. Support will help with a refund or another charger.
          </p>
        </form>
      ) : null}
    </section>
  );
}
