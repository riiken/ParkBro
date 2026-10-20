'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useEffect, useState, type FormEvent } from 'react';
import { FormError } from '../../../components/field';
import { formatTime } from '../../../lib/booking';

type Result =
  | { valid: false; reason: 'NO_BOOKING_NOW' }
  | {
      valid: true;
      unitLabel: string | null;
      validUntil: string;
      expectedPlate: string;
      alreadyEntered: boolean;
      entryTicket: string;
    };

/**
 * G-01 guard surface (ux §6, trust-and-safety §10.3): one screen, full plate or full code, a clear verdict, then
 * "Allow entry". It shows no names, phones or prices. Every check is logged for the property.
 */
export function GuardView({ token }: { token: string }) {
  const base = `/api/v1/gate/${encodeURIComponent(token)}`;
  const [gate, setGate] = useState<{ label: string } | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [entered, setEntered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest<{ label: string }>(base)
      .then(setGate)
      .catch((e: unknown) =>
        setGateError(e instanceof ApiError ? e.userMessage : 'This gate link could not be loaded.'),
      );
  }, [base]);

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    setBusy(true);
    setError(null);
    setResult(null);
    setEntered(false);
    try {
      const body = /^\d{6}$/.test(value.replace(/\s/g, ''))
        ? { code: value.replace(/\s/g, '') }
        : { plate: value };
      setResult(await apiRequest<Result>(`${base}/lookup`, { method: 'POST', body }));
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Check failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function allow() {
    if (!result?.valid) return;
    setBusy(true);
    try {
      await apiRequest(`${base}/entries`, { method: 'POST', body: { ticket: result.entryTicket } });
      setEntered(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not record the entry.');
    } finally {
      setBusy(false);
    }
  }

  if (gateError) return <p className="notice">{gateError}</p>;
  if (!gate) return <p aria-busy="true">Loading…</p>;
  return (
    <div className="guard">
      <h1>{gate.label}</h1>
      <form onSubmit={check} noValidate>
        <div className="field">
          <label htmlFor="q">Vehicle number or 6-digit code</label>
          <input
            id="q"
            name="q"
            autoComplete="off"
            autoCapitalize="characters"
            placeholder="KA 01 AB 1234"
            required
            maxLength={20}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </form>
      <FormError message={error} />
      {result ? (
        result.valid ? (
          <div aria-live="polite" className="section">
            <p className="verdict ok">Valid now</p>
            <p>
              {result.unitLabel ? `Space ${result.unitLabel} · ` : ''}until {formatTime(result.validUntil)}
            </p>
            <p>
              Check the plate: <strong>{result.expectedPlate}</strong>
            </p>
            {entered || result.alreadyEntered ? (
              <p className="success" role="status">
                {entered ? 'Entry recorded.' : 'Already entered once.'}
              </p>
            ) : null}
            {!entered ? (
              <button type="button" disabled={busy} onClick={() => void allow()}>
                Allow entry
              </button>
            ) : null}
          </div>
        ) : (
          <div aria-live="polite" className="section">
            <p className="verdict no">Not valid: no booking right now</p>
            <p className="small">
              Don&apos;t let the vehicle in. If the driver insists, ask them to contact support from the app.
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}
