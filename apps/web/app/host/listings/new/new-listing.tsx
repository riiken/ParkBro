'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../../../components/field';
import { HostGate } from '../../../../components/host-gate';
import type { HostAsset, HostProperty } from '../../../../lib/host';

interface Prediction {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}
interface Place {
  name: string;
  latitude: number;
  longitude: number;
}

const KIND_LABEL: Record<string, string> = {
  INDEPENDENT_HOUSE: 'House (independent home)',
  COMMERCIAL: 'Shop or commercial building',
  OFFICE: 'Office',
  OTHER: 'Other private property',
  APARTMENT_SOCIETY: 'Apartment society',
};

/**
 * H-02 steps 1–2: where the space is (private address, exact point for verification, public locality) and what it is
 * called. Everything else is filled in the listing editor, which saves each section as a draft.
 * Apartment societies are onboarded by ParkBro with the committee's consent (D-067), so they appear here only
 * once the host is an approved member.
 */
export function NewListing() {
  return <HostGate>{() => <Create />}</HostGate>;
}

function Create() {
  const router = useRouter();
  const [properties, setProperties] = useState<HostProperty[] | null>(null);
  const [propertyId, setPropertyId] = useState<string>('new');
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [pointSource, setPointSource] = useState<'device' | 'area' | null>(null);
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [areaLabel, setAreaLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest<HostProperty[]>('/api/v1/host/properties')
      .then((list) => {
        setProperties(list);
        if (list[0]) setPropertyId(list[0].id);
      })
      .catch(() => setProperties([]));
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) return setPredictions([]);
    const t = setTimeout(() => {
      apiRequest<Prediction[]>(`/api/v1/places/autocomplete?q=${encodeURIComponent(query.trim())}`)
        .then(setPredictions)
        .catch(() => setPredictions([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function chooseArea(p: Prediction) {
    const place = await apiRequest<Place>(`/api/v1/places/${encodeURIComponent(p.placeId)}`);
    setAreaLabel(p.primaryText);
    setQuery(p.primaryText);
    setPredictions([]);
    if (pointSource !== 'device') {
      setPoint({ latitude: place.latitude, longitude: place.longitude });
      setPointSource('area');
    }
  }

  function useDevice() {
    setError(null);
    if (!navigator.geolocation)
      return setError("This browser can't share your location. Pick your area instead.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setPointSource('device');
      },
      () => setError("We couldn't get your location. Pick your area instead."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      let pid = propertyId;
      if (pid === 'new') {
        if (!point)
          throw new Error(
            'Pick your area or use your current location so we can place the space on the map.',
          );
        const created = await apiRequest<HostProperty>('/api/v1/host/properties', {
          method: 'POST',
          body: {
            kind: String(form.get('kind') ?? 'INDEPENDENT_HOUSE'),
            address: String(form.get('address') ?? ''),
            areaLabel,
            latitude: point.latitude,
            longitude: point.longitude,
          },
        });
        pid = created.id;
      }
      const asset = await apiRequest<HostAsset>('/api/v1/host/assets', {
        method: 'POST',
        body: {
          propertyId: pid,
          type: String(form.get('type') ?? 'PARKING'),
          title: String(form.get('title') ?? ''),
        },
      });
      router.push(`/host/listings/${asset.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.userMessage);
        setFieldErrors(e.fieldErrors);
      } else setError(e instanceof Error ? e.message : 'Could not create the listing.');
      setBusy(false);
    }
  }

  if (!properties) return <p aria-busy="true">Loading…</p>;
  return (
    <form onSubmit={onSubmit} noValidate className="narrow-form">
      <h1>List a space</h1>
      <fieldset className="segmented">
        <legend>What are you listing?</legend>
        <label>
          <input type="radio" name="type" value="PARKING" defaultChecked /> Parking
        </label>
        <label>
          <input type="radio" name="type" value="EV_CHARGING" /> EV charging (charger + parking bay)
        </label>
      </fieldset>

      <h2>Where is it?</h2>
      {properties.length > 0 ? (
        <div className="field">
          <label htmlFor="property">Property</label>
          <select id="property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName ?? p.address} ({KIND_LABEL[p.kind] ?? p.kind})
              </option>
            ))}
            <option value="new">A new property…</option>
          </select>
        </div>
      ) : null}

      {propertyId === 'new' ? (
        <>
          <div className="field">
            <label htmlFor="kind">Type of property</label>
            <select id="kind" name="kind" defaultValue="INDEPENDENT_HOUSE">
              {['INDEPENDENT_HOUSE', 'COMMERCIAL', 'OFFICE', 'OTHER'].map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <p className="hint">
              Live in an apartment society? Ask us to onboard your society; residents list there with the
              committee&apos;s consent.
            </p>
          </div>
          <Field
            id="address"
            name="address"
            label="Full address"
            hint="Private. Shared only with customers who have a confirmed booking."
            maxLength={300}
            required
            error={fieldErrors.address}
          />
          <div className="field combobox">
            <label htmlFor="area">Area (shown publicly)</label>
            <input
              id="area"
              role="combobox"
              aria-expanded={predictions.length > 0}
              aria-controls="area-options"
              aria-autocomplete="list"
              autoComplete="off"
              placeholder="e.g. Koramangala"
              value={query}
              onChange={(e) => (setQuery(e.target.value), setAreaLabel(e.target.value))}
            />
            {predictions.length ? (
              <ul id="area-options" className="options" role="listbox">
                {predictions.map((p) => (
                  <li key={p.placeId} role="option" aria-selected="false">
                    <button type="button" className="link" onClick={() => void chooseArea(p)}>
                      {p.primaryText} <span className="muted small">{p.secondaryText}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {fieldErrors.areaLabel ? <p className="field-error">{fieldErrors.areaLabel}</p> : null}
          </div>
          <div className="field">
            <p className="hint">
              Customers see an approximate area only, never the exact spot, until they book. For the best
              placement, use your location while standing at the space.
            </p>
            <button type="button" className="secondary" onClick={useDevice}>
              Use my current location
            </button>
            {point ? (
              <p className="small success" role="status">
                Location set {pointSource === 'device' ? 'from your device' : 'to the area centre'}.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      <h2>Name it</h2>
      <Field
        id="title"
        name="title"
        label="Listing title"
        hint="For example: Covered driveway near Forum Mall. No phone numbers."
        minLength={5}
        maxLength={80}
        required
        error={fieldErrors.title}
      />
      <FormError message={error} />
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create draft'}
      </button>
    </form>
  );
}
