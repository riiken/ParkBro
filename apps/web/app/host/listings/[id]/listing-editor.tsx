'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { FormError } from '../../../../components/field';
import { HostGate } from '../../../../components/host-gate';
import { formatRupees } from '../../../../lib/booking';
import { CONNECTOR_LABEL, LEVEL_LABEL, MODE_LABEL, VEHICLE_LABEL } from '../../../../lib/format';
import {
  ASSET_STATUS_HINT,
  ASSET_STATUS_LABEL,
  CHECKLIST_LABEL,
  SCHEDULE_PRESETS,
  WEEKDAY_SHORT,
  uploadPhoto,
  type HostAsset,
} from '../../../../lib/host';

const PARKING_MODES = [
  { mode: 'HOURLY', unit: 'PER_HOUR', label: 'Per hour' },
  { mode: 'DAILY', unit: 'PER_DAY', label: 'Per day' },
  { mode: 'OVERNIGHT', unit: 'PER_NIGHT', label: 'Per night' },
  { mode: 'MONTHLY', unit: 'PER_MONTH', label: 'Per month' },
] as const;

/**
 * H-02 / H-04 listing editor. Each section saves on its own (the listing stays a DRAFT until submitted), and the
 * checklist from the server says exactly what is still missing. Material edits to a live listing send it back to
 * review (BR-23); the server decides and the status line shows it.
 */
export function ListingEditor({ id }: { id: string }) {
  return <HostGate>{(account) => <Editor id={id} canWrite={account.status === 'ACTIVE'} />}</HostGate>;
}

function Editor({ id, canWrite }: { id: string; canWrite: boolean }) {
  const [asset, setAsset] = useState<HostAsset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      setAsset(await apiRequest<HostAsset>(`/api/v1/host/assets/${encodeURIComponent(id)}`));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return setNotFound(true);
      setLoadError(e instanceof ApiError ? e.userMessage : 'Could not load the listing.');
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (notFound)
    return (
      <p>
        We couldn&apos;t find that listing. <Link href="/host/listings">Your listings</Link>
      </p>
    );
  if (loadError) return <FormError message={loadError} />;
  if (!asset) return <p aria-busy="true">Loading listing…</p>;

  const a = asset;
  const props = {
    asset: a,
    onSaved: setAsset,
    disabled: !canWrite || a.status === 'ARCHIVED' || a.status === 'SUSPENDED',
  };
  return (
    <div>
      <p>
        <Link href="/host/listings">← Your listings</Link>
      </p>
      <h1>{a.title}</h1>
      <p>
        <span className={`status status-${a.status.toLowerCase()}`}>
          {ASSET_STATUS_LABEL[a.status] ?? a.status}
        </span>{' '}
        <span className="muted small">{ASSET_STATUS_HINT[a.status]}</span>
        {a.statusReason ? <span className="small"> Reason: {a.statusReason}</span> : null}
      </p>
      {a.status !== 'DRAFT' && a.status !== 'ARCHIVED' ? (
        <p>
          <Link href={`/host/listings/${a.id}/calendar`}>Open calendar and block time</Link>
        </p>
      ) : null}

      <Checklist {...props} />
      <DetailsSection {...props} />
      {a.type === 'EV_CHARGING' ? <ChargerSection {...props} /> : null}
      <SpacesSection {...props} />
      <PhotosSection {...props} />
      <PricesSection {...props} />
      <ScheduleSection {...props} />
      <RulesSection {...props} />
      <SettingsSection {...props} />
      <AttestationSection {...props} kind="RIGHT_TO_RENT" />
      {a.type === 'EV_CHARGING' ? <AttestationSection {...props} kind="CHARGER_SAFETY" /> : null}
      <Lifecycle {...props} />
    </div>
  );
}

interface SectionProps {
  asset: HostAsset;
  onSaved: (a: HostAsset) => void;
  disabled: boolean;
}

/** Shared save handling: busy, error, field errors and a short success note. */
function useSave(onSaved: (a: HostAsset) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  async function run(call: () => Promise<HostAsset>) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      onSaved(await call());
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.userMessage);
        setFieldErrors(e.fieldErrors);
      } else setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, fieldErrors, saved, run };
}

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function SaveRow({
  busy,
  saved,
  error,
  disabled,
  label = 'Save',
}: {
  busy: boolean;
  saved: boolean;
  error: string | null;
  disabled: boolean;
  label?: string;
}) {
  return (
    <>
      <FormError message={error} />
      <div className="row-start">
        <button type="submit" disabled={busy || disabled}>
          {busy ? 'Saving…' : label}
        </button>
        {saved ? (
          <span role="status" className="success small">
            Saved
          </span>
        ) : null}
      </div>
    </>
  );
}

const put = (assetId: string, path: string, body: unknown) =>
  apiRequest<HostAsset>(`/api/v1/host/assets/${assetId}/${path}`, { method: 'PUT', body });
const patch = (a: HostAsset, body: Record<string, unknown>) =>
  apiRequest<HostAsset>(`/api/v1/host/assets/${a.id}`, {
    method: 'PATCH',
    body: { version: a.version, ...body },
  });

function Checklist({ asset }: SectionProps) {
  if (asset.status !== 'DRAFT' && asset.checklist.ready) return null;
  return (
    <div className="notice" aria-live="polite">
      {asset.checklist.ready ? (
        <p>Everything is ready. Submit for review at the bottom of the page.</p>
      ) : (
        <>
          <p>
            <strong>Still to do</strong>
          </p>
          <ul>
            {asset.checklist.missing.map((m) => (
              <li key={m}>{CHECKLIST_LABEL[m] ?? m}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DetailsSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const d = asset.parkingDetails;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (String(f.get(k) ?? '').trim() ? Math.round(Number(f.get(k)) * 100) : null);
    void s.run(() =>
      put(asset.id, 'parking-details', {
        covered: f.get('covered') === 'yes',
        level: String(f.get('level')),
        maxVehicleClass: String(f.get('maxVehicleClass')),
        heightCm: num('heightM'),
        lengthCm: num('lengthM'),
        security: ['CCTV', 'GUARD', 'GATED'].filter((x) => f.get(`sec-${x}`) === 'on'),
        lighting: f.get('lighting') === 'on',
        evReadySocket: f.get('evReadySocket') === 'on',
        tandem: f.get('tandem') === 'on',
      }),
    );
  }
  return (
    <Section title={asset.type === 'EV_CHARGING' ? 'The parking bay' : 'The space'} id="details">
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="segmented">
          <legend>Covered?</legend>
          <label>
            <input type="radio" name="covered" value="yes" defaultChecked={d?.covered ?? true} /> Covered
          </label>
          <label>
            <input type="radio" name="covered" value="no" defaultChecked={d ? !d.covered : false} /> Open
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor="level">Where</label>
          <select id="level" name="level" defaultValue={d?.level ?? 'GROUND'}>
            {Object.entries(LEVEL_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="maxVehicleClass">Largest vehicle that fits</label>
          <select id="maxVehicleClass" name="maxVehicleClass" defaultValue={d?.maxVehicleClass ?? 'SEDAN'}>
            {Object.entries(VEHICLE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="heightM">Height limit (m, optional)</label>
            <input
              id="heightM"
              name="heightM"
              type="number"
              step="0.01"
              min="1.5"
              max="5"
              defaultValue={d?.heightCm ? d.heightCm / 100 : ''}
            />
          </div>
          <div className="field">
            <label htmlFor="lengthM">Length (m, optional)</label>
            <input
              id="lengthM"
              name="lengthM"
              type="number"
              step="0.1"
              min="3"
              max="8"
              defaultValue={d?.lengthCm ? d.lengthCm / 100 : ''}
            />
          </div>
        </div>
        <fieldset className="checks">
          <legend>Security and features</legend>
          {(['CCTV', 'GUARD', 'GATED'] as const).map((x) => (
            <label key={x} className="check">
              <input type="checkbox" name={`sec-${x}`} defaultChecked={d?.security.includes(x)} />{' '}
              {x === 'CCTV' ? 'CCTV' : x === 'GUARD' ? 'Security guard' : 'Gated'}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" name="lighting" defaultChecked={d?.lighting} /> Well lit at night
          </label>
          <label className="check">
            <input type="checkbox" name="evReadySocket" defaultChecked={d?.evReadySocket} /> EV-ready socket
            nearby
          </label>
          <label className="check">
            <input type="checkbox" name="tandem" defaultChecked={d?.tandem} /> Tandem (another car may block
            it)
          </label>
        </fieldset>
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

/** Charger facts (domain-model §3.2). Speed and compatibility shown to drivers come from these. */
function ChargerSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const c = asset.chargerDetails;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void s.run(() =>
      put(asset.id, 'charger-details', {
        connectors: Object.keys(CONNECTOR_LABEL).filter((k) => f.get(`conn-${k}`) === 'on'),
        currentType: String(f.get('currentType') ?? 'AC'),
        powerKw: Math.round(Number(f.get('powerKw') ?? 0) * 10) / 10,
        cableProvided: f.get('cableProvided') === 'on',
        connectionType: String(f.get('connectionType') ?? 'EV_METERED'),
      }),
    );
  }
  return (
    <Section title="The charger" id="charger">
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="checks">
          <legend>Connectors</legend>
          {Object.entries(CONNECTOR_LABEL).map(([k, label]) => (
            <label key={k} className="check">
              <input
                type="checkbox"
                name={`conn-${k}`}
                defaultChecked={c ? c.connectors.includes(k) : k === 'TYPE2'}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        <div className="row">
          <div className="field">
            <label htmlFor="currentType">Current</label>
            <select id="currentType" name="currentType" defaultValue={c?.currentType ?? 'AC'}>
              <option value="AC">AC</option>
              <option value="DC">DC (fast charger)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="powerKw">Rated power (kW)</label>
            <input
              id="powerKw"
              name="powerKw"
              type="number"
              min="1"
              max="400"
              step="0.1"
              defaultValue={c?.powerKw ?? 7.4}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="connectionType">Electricity connection</label>
          <select id="connectionType" name="connectionType" defaultValue={c?.connectionType ?? 'EV_METERED'}>
            <option value="EV_METERED">Separate EV meter</option>
            <option value="DOMESTIC">Home connection</option>
            <option value="COMMERCIAL">Commercial connection</option>
          </select>
        </div>
        <label className="check">
          <input type="checkbox" name="cableProvided" defaultChecked={c?.cableProvided ?? true} /> Cable
          provided
        </label>
        <p className="hint">
          Charging is self-reported by the driver (start and stop in the app); we don&apos;t connect to your
          charger yet. Price per hour or per session, not per kWh.
        </p>
        {s.fieldErrors.connectors ? <p className="field-error">{s.fieldErrors.connectors}</p> : null}
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function SpacesSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const active = asset.units.filter((u) => u.status === 'ACTIVE').map((u) => u.label);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get('labels') ?? '');
    const labels = raw
      .split(/[\n,]/)
      .map((l) => l.trim())
      .filter(Boolean);
    void s.run(() => put(asset.id, 'units', { labels }));
  }
  return (
    <Section title="Spaces" id="spaces">
      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="labels">Space labels, one per line</label>
          <p className="hint" id="labels-hint">
            One label per identical space, e.g. &quot;B-12&quot;. Labels are shared only after a booking is
            confirmed.
          </p>
          <textarea
            id="labels"
            name="labels"
            rows={3}
            aria-describedby="labels-hint"
            defaultValue={active.join('\n') || 'Space 1'}
          />
          {s.fieldErrors.labels ? <p className="field-error">{s.fieldErrors.labels}</p> : null}
        </div>
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function PhotosSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const [kind, setKind] = useState('SLOT');
  function onFile(file: File | undefined) {
    if (!file) return;
    void s.run(() => uploadPhoto(asset.id, kind, file));
  }
  function remove(mediaId: string) {
    void s.run(async () => {
      await apiRequest(`/api/v1/host/assets/${asset.id}/media/${mediaId}`, { method: 'DELETE' });
      return apiRequest<HostAsset>(`/api/v1/host/assets/${asset.id}`);
    });
  }
  return (
    <Section title="Photos" id="photos">
      <p className="hint">
        A clear photo of the space is required; add the entrance too. Location data in photos is removed.
      </p>
      <ul className="thumbs">
        {asset.media.map((m) => (
          <li key={m.id}>
            {/* eslint-disable-next-line @next/next/no-img-element -- see listings/[id]/page.tsx (D-098) */}
            <img
              src={m.url}
              alt={`${m.kind.toLowerCase()} photo`}
              width={m.width}
              height={m.height}
              loading="lazy"
            />
            <span className="small muted">
              {m.kind === 'SLOT'
                ? 'Space'
                : m.kind === 'ENTRANCE'
                  ? 'Entrance'
                  : m.kind === 'CHARGER'
                    ? 'Charger'
                    : 'Other'}
              {m.moderationStatus === 'REJECTED' ? ' · rejected' : ''}
            </span>{' '}
            {disabled ? null : (
              <button type="button" className="link" onClick={() => remove(m.id)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {disabled ? null : (
        <div className="row-start">
          <div className="field">
            <label htmlFor="photo-kind">Photo of</label>
            <select id="photo-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="SLOT">The space</option>
              {asset.type === 'EV_CHARGING' ? (
                <option value="CHARGER">The charger (with nameplate)</option>
              ) : null}
              <option value="ENTRANCE">The entrance</option>
              <option value="OTHER">Something else</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="photo-file">Add photo</label>
            <input
              id="photo-file"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              disabled={s.busy}
              onChange={(e) => (onFile(e.target.files?.[0]), (e.target.value = ''))}
            />
          </div>
        </div>
      )}
      {s.busy ? <p aria-busy="true">Uploading…</p> : null}
      <FormError message={s.error} />
    </Section>
  );
}

function PricesSection(props: SectionProps) {
  return props.asset.type === 'EV_CHARGING' ? <ChargingPrice {...props} /> : <ParkingPrices {...props} />;
}

/** EV: one charging price, per hour or per session (D-005: no per-kWh pricing without metering). */
function ChargingPrice({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const rate = asset.rates.find((r) => r.mode === 'CHARGING_SESSION');
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = String(f.get('price') ?? '').trim();
    const rates = v
      ? [
          {
            mode: 'CHARGING_SESSION',
            unit: String(f.get('unit') ?? 'PER_HOUR'),
            pricePaise: Math.round(Number(v) * 100),
          },
        ]
      : [];
    void s.run(() => put(asset.id, 'rates', { rates }));
  }
  return (
    <Section title="Prices" id="prices">
      <form onSubmit={onSubmit} noValidate>
        <div className="row">
          <div className="field">
            <label htmlFor="price">Charging price (₹)</label>
            <input
              id="price"
              name="price"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              defaultValue={rate ? rate.pricePaise / 100 : ''}
            />
          </div>
          <div className="field">
            <label htmlFor="unit">Charged</label>
            <select id="unit" name="unit" defaultValue={rate?.unit ?? 'PER_HOUR'}>
              <option value="PER_HOUR">Per hour</option>
              <option value="PER_SESSION">Per session</option>
            </select>
          </div>
        </div>
        <p className="hint">
          Includes the parking bay while the car charges. Set the shortest and longest session under Booking
          settings.
        </p>
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function ParkingPrices({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const rate = (mode: string) => asset.rates.find((r) => r.mode === mode);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const rates = PARKING_MODES.flatMap(({ mode, unit }) => {
      const v = String(f.get(`price-${mode}`) ?? '').trim();
      if (!v) return [];
      return [
        {
          mode,
          unit,
          pricePaise: Math.round(Number(v) * 100),
          overnightStart: mode === 'OVERNIGHT' ? String(f.get('overnightStart') || '20:00') : null,
          overnightEnd: mode === 'OVERNIGHT' ? String(f.get('overnightEnd') || '08:00') : null,
        },
      ];
    });
    void s.run(() => put(asset.id, 'rates', { rates }));
  }
  return (
    <Section title="Prices" id="prices">
      <form onSubmit={onSubmit} noValidate>
        <p className="hint">
          Leave a price empty to not offer that booking type. Prices include everything the customer pays you.
        </p>
        {PARKING_MODES.map(({ mode, label }) => (
          <div className="field" key={mode}>
            <label htmlFor={`price-${mode}`}>
              {MODE_LABEL[mode]} ({label.toLowerCase()}, ₹)
            </label>
            <input
              id={`price-${mode}`}
              name={`price-${mode}`}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              defaultValue={rate(mode) ? (rate(mode)?.pricePaise ?? 0) / 100 : ''}
            />
          </div>
        ))}
        <div className="row">
          <div className="field">
            <label htmlFor="overnightStart">Overnight from</label>
            <input
              id="overnightStart"
              name="overnightStart"
              type="time"
              defaultValue={rate('OVERNIGHT')?.overnightStart ?? '20:00'}
            />
          </div>
          <div className="field">
            <label htmlFor="overnightEnd">Overnight until</label>
            <input
              id="overnightEnd"
              name="overnightEnd"
              type="time"
              defaultValue={rate('OVERNIGHT')?.overnightEnd ?? '08:00'}
            />
          </div>
        </div>
        {asset.rates.length ? (
          <p className="small muted">
            Now:{' '}
            {asset.rates
              .map((r) => `${MODE_LABEL[r.mode] ?? r.mode} ${formatRupees(r.pricePaise)}`)
              .join(' · ')}
          </p>
        ) : null}
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function ScheduleSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const current = JSON.stringify(
    asset.availabilityRules.map(({ weekdays, startLocal, endLocal }) => ({ weekdays, startLocal, endLocal })),
  );
  const matched = SCHEDULE_PRESETS.find((p) => JSON.stringify(p.rules) === current)?.id;
  const [choice, setChoice] = useState(matched ?? (asset.availabilityRules.length ? 'custom' : 'always'));
  const first = asset.availabilityRules[0];
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const preset = SCHEDULE_PRESETS.find((p) => p.id === choice);
    const rules = preset
      ? preset.rules
      : [
          {
            weekdays: [1, 2, 3, 4, 5, 6, 7].filter((d) => f.get(`day-${d}`) === 'on'),
            startLocal: String(f.get('startLocal') || '09:00'),
            endLocal: String(f.get('endLocal') || '19:00'),
          },
        ];
    void s.run(() => put(asset.id, 'availability-rules', { rules }));
  }
  return (
    <Section title="When it's available" id="schedule">
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="checks">
          <legend>Weekly schedule</legend>
          {[
            ...SCHEDULE_PRESETS.map((p) => ({ id: p.id, label: p.label })),
            { id: 'custom', label: 'Custom' },
          ].map((p) => (
            <label key={p.id} className="check">
              <input
                type="radio"
                name="preset"
                value={p.id}
                checked={choice === p.id}
                onChange={() => setChoice(p.id)}
              />{' '}
              {p.label}
            </label>
          ))}
        </fieldset>
        {choice === 'custom' ? (
          <>
            <fieldset className="checks">
              <legend>Days</legend>
              {WEEKDAY_SHORT.map((label, i) => (
                <label key={label} className="check">
                  <input
                    type="checkbox"
                    name={`day-${i + 1}`}
                    defaultChecked={first ? first.weekdays.includes(i + 1) : i < 5}
                  />{' '}
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="row">
              <div className="field">
                <label htmlFor="startLocal">From</label>
                <input
                  id="startLocal"
                  name="startLocal"
                  type="time"
                  defaultValue={first?.startLocal ?? '09:00'}
                />
              </div>
              <div className="field">
                <label htmlFor="endLocal">Until</label>
                <input id="endLocal" name="endLocal" type="time" defaultValue={first?.endLocal ?? '19:00'} />
              </div>
            </div>
            <p className="hint">
              An end at or before the start runs past midnight. Monthly bookings need 24/7 availability.
            </p>
          </>
        ) : null}
        <p className="small muted">Block specific dates later from the calendar.</p>
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function RulesSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const access = String(f.get('accessInstructions') ?? '').trim();
    void s.run(() =>
      patch(asset, {
        title: String(f.get('title') ?? ''),
        description: String(f.get('description') ?? ''),
        rulesText: String(f.get('rulesText') ?? ''),
        accessInstructions: access || null,
      }),
    );
  }
  return (
    <Section title="Description, rules and access" id="rules">
      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" name="title" defaultValue={asset.title} minLength={5} maxLength={80} required />
          {s.fieldErrors.title ? <p className="field-error">{s.fieldErrors.title}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="description">Description (public)</label>
          <textarea
            id="description"
            name="description"
            rows={3}
            maxLength={1000}
            defaultValue={asset.description}
          />
          {s.fieldErrors.description ? <p className="field-error">{s.fieldErrors.description}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="rulesText">House rules (public)</label>
          <textarea
            id="rulesText"
            name="rulesText"
            rows={3}
            maxLength={1000}
            defaultValue={asset.rulesText}
          />
          {s.fieldErrors.rulesText ? <p className="field-error">{s.fieldErrors.rulesText}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="accessInstructions">How to get in (private)</label>
          <p className="hint" id="access-hint">
            Shown only to a customer with a confirmed booking, until 24 hours after it ends. Gate codes and
            directions go here.
          </p>
          <textarea
            id="accessInstructions"
            name="accessInstructions"
            rows={3}
            maxLength={1000}
            aria-describedby="access-hint"
            defaultValue={asset.accessInstructions ?? ''}
          />
        </div>
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function SettingsSection({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void s.run(() =>
      patch(asset, {
        approvalRequired: f.get('approvalRequired') === 'on',
        bufferMinutes: Number(f.get('bufferMinutes') ?? 0),
        minMinutes: Math.round(Number(f.get('minHours') ?? 1) * 60),
        maxMinutes: Math.round(Number(f.get('maxHours') ?? 24) * 60),
        leadMinutes: Math.round(Number(f.get('leadHours') ?? 0) * 60),
        cancellationPolicy: String(f.get('cancellationPolicy') ?? 'MODERATE'),
      }),
    );
  }
  return (
    <Section title="Booking settings" id="settings">
      <form onSubmit={onSubmit} noValidate>
        <label className="check">
          <input type="checkbox" name="approvalRequired" defaultChecked={asset.approvalRequired} /> I approve
          each request (monthly requests always need your approval)
        </label>
        <div className="row">
          <div className="field">
            <label htmlFor="minHours">Shortest hourly or charging booking (hours)</label>
            <input
              id="minHours"
              name="minHours"
              type="number"
              min="0.25"
              step="0.25"
              defaultValue={asset.minMinutes / 60}
            />
          </div>
          <div className="field">
            <label htmlFor="maxHours">Longest hourly or charging booking (hours)</label>
            <input
              id="maxHours"
              name="maxHours"
              type="number"
              min="0.25"
              step="0.25"
              defaultValue={asset.maxMinutes / 60}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="leadHours">Notice needed (hours)</label>
            <input
              id="leadHours"
              name="leadHours"
              type="number"
              min="0"
              max="168"
              step="0.5"
              defaultValue={asset.leadMinutes / 60}
            />
          </div>
          <div className="field">
            <label htmlFor="bufferMinutes">Gap between bookings (minutes)</label>
            <input
              id="bufferMinutes"
              name="bufferMinutes"
              type="number"
              min="0"
              max="240"
              step="5"
              defaultValue={asset.bufferMinutes}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="cancellationPolicy">Cancellation policy</label>
          <select id="cancellationPolicy" name="cancellationPolicy" defaultValue={asset.cancellationPolicy}>
            <option value="FLEXIBLE">Flexible: full refund up to 1 hour before, then 50%</option>
            <option value="MODERATE">Moderate: full refund up to 24 hours before, then 50%</option>
            <option value="STRICT">Strict: full refund up to 7 days before, 50% up to 24 hours</option>
          </select>
          <p className="hint">Changes apply to new bookings only.</p>
        </div>
        <SaveRow {...s} disabled={disabled} />
      </form>
    </Section>
  );
}

function AttestationSection({
  asset,
  onSaved,
  disabled,
  kind,
}: SectionProps & { kind: 'RIGHT_TO_RENT' | 'CHARGER_SAFETY' }) {
  const s = useSave(onSaved);
  const att = asset.attestations[kind];
  if (!att) return null;
  const done = att.status === 'ATTESTED';
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void s.run(() =>
      apiRequest<HostAsset>(`/api/v1/host/assets/${asset.id}/attestations`, {
        method: 'POST',
        body: { kind, accepted: true },
      }),
    );
  }
  return (
    <Section title={kind === 'CHARGER_SAFETY' ? 'Charger safety' : 'Your confirmation'} id={`attest-${kind}`}>
      <form onSubmit={onSubmit} noValidate>
        <blockquote>{att.statement.text}</blockquote>
        {done ? (
          <p className="success">Confirmed.</p>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" name="accept" required /> I confirm this is true
              {kind === 'CHARGER_SAFETY' ? ' for this charger' : ''}
            </label>
            <SaveRow {...s} disabled={disabled} label="Confirm" />
          </>
        )}
      </form>
    </Section>
  );
}

function Lifecycle({ asset, onSaved, disabled }: SectionProps) {
  const s = useSave(onSaved);
  const act = (path: string) =>
    s.run(() =>
      apiRequest<HostAsset>(`/api/v1/host/assets/${asset.id}/${path}`, { method: 'POST', body: {} }),
    );
  return (
    <Section title="Publishing" id="publish">
      <FormError message={s.error} />
      <div className="row-start">
        {asset.status === 'DRAFT' || (asset.status === 'PAUSED' && asset.needsReview) ? (
          <button
            type="button"
            disabled={disabled || s.busy || !asset.checklist.ready}
            onClick={() => void act('submit')}
          >
            Submit for review
          </button>
        ) : null}
        {asset.status === 'PUBLISHED' ? (
          <button
            type="button"
            className="secondary"
            disabled={disabled || s.busy}
            onClick={() => void act('pause')}
          >
            Pause listing
          </button>
        ) : null}
        {asset.status === 'PAUSED' && !asset.needsReview ? (
          <button type="button" disabled={disabled || s.busy} onClick={() => void act('republish')}>
            Publish again
          </button>
        ) : null}
        {['DRAFT', 'PAUSED'].includes(asset.status) ? (
          <button
            type="button"
            className="link"
            disabled={disabled || s.busy}
            onClick={() => void act('archive')}
          >
            Archive
          </button>
        ) : null}
      </div>
      {asset.status === 'DRAFT' && !asset.checklist.ready ? (
        <p className="small muted">Finish the steps listed at the top to submit.</p>
      ) : null}
    </Section>
  );
}
