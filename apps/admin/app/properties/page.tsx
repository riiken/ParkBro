'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { PagedList, when } from '../../lib/admin';

interface Prediction {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}

interface P {
  id: string;
  kind: string;
  displayName: string | null;
  areaLabel: string;
  participationStatus: string;
  createdAt: string;
}

export default function PropertiesPage() {
  return (
    <div>
      <h1>Properties</h1>
      <p className="muted small">
        Lists never show exact addresses. Opening a property shows it and is logged.
      </p>
      <NewSociety />
      <PagedList<P>
        base="/api/admin/v1/properties"
        filters={[
          { name: 'q', label: 'Area or name' },
          {
            name: 'kind',
            label: 'Kind',
            options: [
              ['INDEPENDENT_HOUSE', 'House'],
              ['APARTMENT_SOCIETY', 'Society'],
              ['COMMERCIAL', 'Commercial'],
              ['OFFICE', 'Office'],
              ['OTHER', 'Other'],
            ],
          },
          {
            name: 'participation',
            label: 'Participation',
            options: [
              ['NOT_REQUIRED', 'Not required'],
              ['PARTICIPATING', 'Participating'],
              ['CONSENT_REQUIRED', 'Consent required'],
              ['SUSPENDED', 'Suspended'],
            ],
          },
        ]}
        rowKey={(p) => p.id}
        columns={[
          {
            label: 'Name',
            render: (p) => <Link href={`/properties/${p.id}`}>{p.displayName ?? 'Open'}</Link>,
          },
          { label: 'Area', render: (p) => p.areaLabel },
          { label: 'Kind', render: (p) => p.kind },
          { label: 'Participation', render: (p) => p.participationStatus },
          { label: 'Created', render: (p) => when(p.createdAt) },
        ]}
      />
    </div>
  );
}

/** Onboard an apartment society (PJ-1): residents then list there as member hosts, with the committee's consent. */
function NewSociety() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [point, setPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [areaLabel, setAreaLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length < 2 || point) return setPredictions([]);
    const t = setTimeout(() => {
      apiRequest<Prediction[]>(`/api/v1/places/autocomplete?q=${encodeURIComponent(query.trim())}`)
        .then(setPredictions)
        .catch(() => setPredictions([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, point]);

  async function choose(p: Prediction) {
    const place = await apiRequest<{ latitude: number; longitude: number }>(
      `/api/v1/places/${encodeURIComponent(p.placeId)}`,
    );
    setPoint({ latitude: place.latitude, longitude: place.longitude });
    setQuery(p.primaryText);
    setPredictions([]);
    const { areaLabel: label } = await apiRequest<{ areaLabel: string | null }>(
      `/api/v1/places/area?lat=${place.latitude}&lng=${place.longitude}`,
    ).catch(() => ({ areaLabel: null }));
    setAreaLabel(label ?? p.primaryText);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!point) return setError('Find the society on the map search first.');
    setBusy(true);
    setError(null);
    try {
      const cap = Number(f.get('outsiderCap') || 0);
      const created = await apiRequest<{ id: string }>('/api/admin/properties/societies', {
        method: 'POST',
        body: {
          displayName: String(f.get('displayName') ?? '').trim(),
          address: String(f.get('address') ?? '').trim(),
          areaLabel: areaLabel.trim(),
          latitude: point.latitude,
          longitude: point.longitude,
          ...(cap > 0 ? { outsiderCap: cap } : {}),
        },
      });
      router.push(`/properties/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : 'Could not create the society.');
      setBusy(false);
    }
  }

  if (!open)
    return (
      <p>
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          New society
        </button>
      </p>
    );
  return (
    <form onSubmit={submit} className="panel" aria-label="New society" noValidate>
      <h2>New apartment society</h2>
      <div className="field">
        <label htmlFor="displayName">Society name (shown publicly if it opts in)</label>
        <input id="displayName" name="displayName" required minLength={2} maxLength={80} />
      </div>
      <div className="field">
        <label htmlFor="address">Full address (private)</label>
        <input id="address" name="address" required minLength={5} maxLength={300} />
      </div>
      <div className="field">
        <label htmlFor="place">Find it (map search)</label>
        <input
          id="place"
          value={query}
          autoComplete="off"
          onChange={(e) => (setQuery(e.target.value), setPoint(null))}
          placeholder="Society name or landmark"
        />
        {predictions.length ? (
          <ul className="panel" aria-label="Places">
            {predictions.map((p) => (
              <li key={p.placeId}>
                <button type="button" className="link" onClick={() => void choose(p)}>
                  {p.primaryText} <span className="muted small">{p.secondaryText}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {point ? <p className="small success">Location set.</p> : null}
      </div>
      <div className="field">
        <label htmlFor="areaLabel">Area (shown publicly)</label>
        <input id="areaLabel" value={areaLabel} onChange={(e) => setAreaLabel(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="outsiderCap">Max spaces for outsiders at once (optional)</label>
        <input id="outsiderCap" name="outsiderCap" type="number" min={1} max={500} />
      </div>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="filters">
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create society'}
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
