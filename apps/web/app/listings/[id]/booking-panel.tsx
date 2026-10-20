'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { FormError } from '../../../components/field';
import { addDays, addMonthsClamped, formatRupees, localToIso, todayLocal } from '../../../lib/booking';
import { CONNECTOR_LABEL, MODE_LABEL, VEHICLE_LABEL } from '../../../lib/format';

interface Vehicle {
  id: string;
  plate: string;
  vehicleClass: string;
  isEv: boolean;
  nickname: string | null;
}
interface Quote {
  quoteId: string;
  lines: { label: string; amountPaise: number }[];
  totalPaise: number;
  expiresAt: string;
  approvalRequired: boolean;
}
export interface PanelRate {
  mode: string;
  overnightStart: string | null;
  overnightEnd: string | null;
}
export interface PanelDefaults {
  mode?: string | undefined;
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const TIMED = new Set(['HOURLY', 'CHARGING_SESSION']);
const ORDER = ['HOURLY', 'CHARGING_SESSION', 'DAILY', 'OVERNIGHT', 'MONTHLY'];
const isDate = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v: string | undefined) => !!v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/**
 * Booking box (ux-architecture C-04/C-05): when → vehicle → server price → reserve. Every mode of the listing is
 * bookable here. The price and availability come from the server quote and are re-checked when reserving; nothing
 * here is trusted (CLAUDE.md §13, §25).
 */
export function BookingPanel({
  assetId,
  rates,
  isCharger,
  defaults = {},
  searchHref,
}: {
  assetId: string;
  rates: PanelRate[];
  isCharger: boolean;
  defaults?: PanelDefaults;
  searchHref: string;
}) {
  const router = useRouter();
  const modes = ORDER.filter((m) => rates.some((r) => r.mode === m));
  const [mode, setMode] = useState(
    defaults.mode && modes.includes(defaults.mode) ? defaults.mode : (modes[0] ?? ''),
  );
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [vehicleId, setVehicleId] = useState('');
  const [signedIn, setSignedIn] = useState(true);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addingVehicle, setAddingVehicle] = useState(false);

  async function loadVehicles() {
    try {
      const list = await apiRequest<Vehicle[]>('/api/v1/me/vehicles');
      setVehicles(list);
      setVehicleId((current) => current || (list[0]?.id ?? ''));
      setAddingVehicle(list.length === 0);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSignedIn(false);
      else setError(e instanceof ApiError ? e.userMessage : 'Could not load your vehicles.');
    }
  }
  useEffect(() => {
    void loadVehicles();
  }, []);

  if (modes.length === 0) return <p className="small muted">Booking for this listing opens soon.</p>;
  if (!signedIn) {
    return (
      <Link className="button" href={`/sign-in?next=${encodeURIComponent(`/listings/${assetId}`)}`}>
        Sign in to book
      </Link>
    );
  }

  const overnight = rates.find((r) => r.mode === 'OVERNIGHT');
  const reset = () => (setQuote(null), setUnavailable(false));

  async function onAddVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const isEv = form.get('isEv') === 'on';
      await apiRequest('/api/v1/me/vehicles', {
        method: 'POST',
        body: {
          plate: String(form.get('plate') ?? ''),
          vehicleClass: String(form.get('vehicleClass') ?? 'HATCHBACK'),
          isEv,
          connectors: isEv ? [String(form.get('connector') ?? 'TYPE2')] : [],
        },
      });
      await loadVehicles();
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not add the vehicle.');
    } finally {
      setBusy(false);
    }
  }

  /** The window for the chosen mode, in the pilot zone (BR-13 shapes; the server validates them again). */
  function windowFrom(form: FormData): { start: string; end: string } {
    const date = String(form.get('date') ?? '');
    if (TIMED.has(mode)) {
      const from = String(form.get('from') ?? '');
      const to = String(form.get('to') ?? '');
      return { start: localToIso(date, from), end: localToIso(to <= from ? addDays(date, 1) : date, to) };
    }
    if (mode === 'OVERNIGHT' && overnight?.overnightStart && overnight.overnightEnd) {
      const { overnightStart: s, overnightEnd: e } = overnight;
      return { start: localToIso(date, s), end: localToIso(e <= s ? addDays(date, 1) : date, e) };
    }
    if (mode === 'MONTHLY') {
      const at = String(form.get('from') ?? '09:00');
      return { start: localToIso(date, at), end: localToIso(addMonthsClamped(date, 1), at) };
    }
    const days = Math.max(1, Math.min(30, Number(form.get('days') ?? 1)));
    return { start: localToIso(date, '00:00'), end: localToIso(addDays(date, days), '00:00') };
  }

  async function onQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    reset();
    try {
      const q = await apiRequest<Quote>('/api/v1/quotes', {
        method: 'POST',
        body: { assetId, mode, ...windowFrom(new FormData(event.currentTarget)) },
      });
      setQuote(q);
      setIdempotencyKey(crypto.randomUUID()); // one key per attempt: a double tap or retry can't book twice
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not get a price.');
      setUnavailable(e instanceof ApiError && e.code === 'booking.unavailable');
    } finally {
      setBusy(false);
    }
  }

  async function onReserve(id: string) {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      const booking = await apiRequest<{ id: string }>('/api/v1/bookings', {
        method: 'POST',
        body: { quoteId: quote.quoteId, vehicleId: id },
        headers: { 'idempotency-key': idempotencyKey },
      });
      router.push(`/bookings/${booking.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not reserve.');
      if (e instanceof ApiError && (e.code === 'booking.unavailable' || e.code === 'booking.quote_expired')) {
        setQuote(null);
        setUnavailable(e.code === 'booking.unavailable');
      }
      setBusy(false);
    }
  }

  if (vehicles === null && !error) return <p aria-busy="true">Loading…</p>;

  if (addingVehicle) {
    return (
      <form onSubmit={onAddVehicle} noValidate aria-label="Add your vehicle">
        <h3>Add your vehicle</h3>
        <p className="small muted">Hosts and guards see your number plate during the booking.</p>
        <div className="field">
          <label htmlFor="plate">Registration number</label>
          <input
            id="plate"
            name="plate"
            placeholder="KA 01 AB 1234"
            autoCapitalize="characters"
            required
            maxLength={20}
          />
        </div>
        <div className="field">
          <label htmlFor="vehicleClass">Vehicle type</label>
          <select id="vehicleClass" name="vehicleClass" defaultValue="HATCHBACK">
            {Object.entries(VEHICLE_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" name="isEv" defaultChecked={isCharger} /> Electric vehicle
        </label>
        {isCharger ? (
          <div className="field">
            <label htmlFor="connector">Charging connector</label>
            <select id="connector" name="connector" defaultValue="TYPE2">
              {Object.entries(CONNECTOR_LABEL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <FormError message={error} />
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save vehicle'}
        </button>
      </form>
    );
  }

  const vehicle = vehicles?.find((v) => v.id === vehicleId) ?? vehicles?.[0];
  const today = todayLocal();
  const defaultDate = isDate(defaults.date) && (defaults.date ?? '') >= today ? defaults.date : today;
  return (
    <div>
      <form onSubmit={onQuote} noValidate aria-label="Choose when">
        {modes.length > 1 ? (
          <div className="field">
            <label htmlFor="mode">Booking type</label>
            <select id="mode" value={mode} onChange={(e) => (setMode(e.target.value), reset())}>
              {modes.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="date">
            {mode === 'MONTHLY' ? 'Start date' : mode === 'OVERNIGHT' ? 'Night of' : 'Date'}
          </label>
          <input
            id="date"
            name="date"
            type="date"
            min={today}
            defaultValue={defaultDate}
            required
            onChange={reset}
          />
        </div>
        {TIMED.has(mode) ? (
          <div className="row">
            <div className="field">
              <label htmlFor="from">From</label>
              <input
                id="from"
                name="from"
                type="time"
                step={900}
                defaultValue={isTime(defaults.from) ? defaults.from : '10:00'}
                required
                onChange={reset}
              />
            </div>
            <div className="field">
              <label htmlFor="to">Until</label>
              <input
                id="to"
                name="to"
                type="time"
                step={900}
                defaultValue={isTime(defaults.to) ? defaults.to : '12:00'}
                required
                onChange={reset}
              />
            </div>
          </div>
        ) : mode === 'OVERNIGHT' ? (
          <p className="small muted">
            Overnight: {overnight?.overnightStart}–{overnight?.overnightEnd} the next morning.
          </p>
        ) : mode === 'MONTHLY' ? (
          <>
            <div className="field">
              <label htmlFor="from">From (time)</label>
              <input
                id="from"
                name="from"
                type="time"
                step={900}
                defaultValue="09:00"
                required
                onChange={reset}
              />
            </div>
            <p className="small muted">
              Renews every month on the same date until you or the host give notice. The host approves monthly
              requests.
            </p>
          </>
        ) : (
          <div className="field">
            <label htmlFor="days">Days</label>
            <input
              id="days"
              name="days"
              type="number"
              min={1}
              max={30}
              defaultValue={1}
              required
              onChange={reset}
            />
          </div>
        )}
        {vehicles && vehicles.length > 1 ? (
          <div className="field">
            <label htmlFor="vehicle">Vehicle</label>
            <select
              id="vehicle"
              value={vehicle?.id}
              onChange={(e) => (setVehicleId(e.target.value), reset())}
            >
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nickname ? `${v.nickname} · ` : ''}
                  {v.plate}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {quote ? null : (
          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Check price'}
          </button>
        )}
      </form>

      {quote && vehicle ? (
        <div className="quote" aria-live="polite">
          <table className="prices">
            <tbody>
              {quote.lines.map((l) => (
                <tr key={l.label}>
                  <th scope="row">{l.label}</th>
                  <td>{formatRupees(l.amountPaise)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">
                  <strong>Total{mode === 'MONTHLY' ? ' per month' : ''}</strong>
                </th>
                <td>{formatRupees(quote.totalPaise)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small muted">
            For {vehicle.plate} ({VEHICLE_LABEL[vehicle.vehicleClass] ?? vehicle.vehicleClass}).{' '}
            {quote.approvalRequired ? 'The host approves this request before you pay.' : ''}
          </p>
          <button type="button" disabled={busy} onClick={() => void onReserve(vehicle.id)}>
            {busy
              ? 'Reserving…'
              : mode === 'MONTHLY'
                ? 'Request monthly spot'
                : quote.approvalRequired
                  ? 'Request to book'
                  : 'Reserve'}
          </button>
        </div>
      ) : null}
      <FormError message={error} />
      {unavailable ? (
        <p className="small">
          <Link href={searchHref}>See other spaces nearby</Link>
        </p>
      ) : null}
    </div>
  );
}
