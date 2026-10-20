'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FormError } from '../../components/field';
import { SearchIcon } from '../../components/icons';
import { CONNECTOR_LABEL, MODE_LABEL, VEHICLE_LABEL, formatDistance, formatPrice } from '../../lib/format';

interface Place {
  name: string;
  latitude: number;
  longitude: number;
}
interface Prediction {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}
interface Result {
  id: string;
  type: 'PARKING' | 'EV_CHARGING';
  title: string;
  areaLabel: string;
  distanceM: number;
  price: { mode: string; unit: string; pricePaise: number };
  photo: { url: string; width: number; height: number } | null;
  covered: boolean;
  security: string[];
  evReady: boolean;
  maxVehicleClass: string;
  approvalRequired: boolean;
  charger: { connectors: string[]; currentType: string; powerKw: number } | null;
}
interface SearchResponse {
  results: Result[];
  nextCursor: string | null;
}

interface AiAnswer {
  id: string;
  filters: {
    type: 'PARKING' | 'EV_CHARGING';
    place: Place | null;
    useMyLocation: boolean;
    mode: string | null;
    date: string | null;
    from: string | null;
    to: string | null;
    maxPricePaise: number | null;
    covered: boolean;
    security: ('CCTV' | 'GUARD' | 'GATED')[];
    evReady: boolean;
    vehicleClass: string | null;
    connector: string | null;
    currentType: 'AC' | 'DC' | null;
    minPowerKw: number | null;
  };
  chips: string[];
  notes: string[];
}

const PARKING_MODES = ['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY'] as const;
const MODE_UNIT: Record<string, string> = {
  HOURLY: 'hour',
  DAILY: 'day',
  OVERNIGHT: 'night',
  MONTHLY: 'month',
};

/** Customer search (ux-architecture C-01–C-03). Times are entered in IST for the Bengaluru pilot (D-004). */
export function SearchView() {
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [place, setPlace] = useState<Place | null>(null);
  const [type, setType] = useState<'PARKING' | 'EV_CHARGING'>('PARKING');
  const [mode, setMode] = useState('');
  const [date, setDate] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState({
    covered: false,
    cctv: false,
    guard: false,
    gated: false,
    evReady: false,
    vehicleClass: '',
    connector: '',
    minPowerKw: '',
  });
  const [maxPrice, setMaxPrice] = useState('');
  const [currentType, setCurrentType] = useState('');
  const [sort, setSort] = useState<'distance' | 'price'>('distance');
  const [radiusM, setRadiusM] = useState(3000);
  const [results, setResults] = useState<Result[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState<AiAnswer | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [pendingRun, setPendingRun] = useState(false);

  useEffect(() => {
    clearTimeout(debounce.current);
    if (query.trim().length < 2 || place?.name === query) {
      setPredictions([]);
      return;
    }
    debounce.current = setTimeout(() => {
      apiRequest<Prediction[]>(`/api/v1/places/autocomplete?q=${encodeURIComponent(query.trim())}`)
        .then(setPredictions)
        .catch(() => setPredictions([]));
    }, 250);
    return () => clearTimeout(debounce.current);
  }, [query, place?.name]);

  const [fitsVehicle, setFitsVehicle] = useState<string | null>(null);
  /** ux §4.4 / BR-12: for a signed-in driver with an EV, start from chargers that fit their car. */
  async function preferMyConnector() {
    try {
      const vehicles =
        await apiRequest<{ plate: string; isEv: boolean; connectors: string[] }[]>('/api/v1/me/vehicles');
      const evCar = vehicles.find((v) => v.isEv && v.connectors.length > 0);
      if (evCar) {
        setFilters((f) => (f.connector ? f : { ...f, connector: evCar.connectors[0] ?? '' }));
        setFitsVehicle(evCar.plate);
      }
    } catch {
      // Signed out or offline: search works without it.
    }
  }

  async function choose(prediction: Prediction) {
    const details = await apiRequest<Place & { placeId: string }>(
      `/api/v1/places/${encodeURIComponent(prediction.placeId)}`,
    );
    setPlace({ name: prediction.primaryText, latitude: details.latitude, longitude: details.longitude });
    setQuery(prediction.primaryText);
    setPredictions([]);
  }

  function locateMe() {
    if (!navigator.geolocation) {
      setError('Location is not available in this browser. Search for a place instead.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPlace({ name: 'Your location', latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setQuery('Your location');
      },
      () => setError("We couldn't get your location. Search for a place instead."),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }

  function buildParams(cursor?: string, radius = radiusM): URLSearchParams | null {
    if (!place) return null;
    const p = new URLSearchParams({
      lat: String(place.latitude),
      lng: String(place.longitude),
      type,
      radiusM: String(radius),
      sort,
    });
    const price = Number(maxPrice);
    const pricedMode = mode || (price > 0 ? (type === 'PARKING' ? 'HOURLY' : 'CHARGING_SESSION') : '');
    if (pricedMode) p.set('mode', pricedMode);
    if (price > 0) p.set('maxPricePaise', String(Math.round(price * 100)));
    if (date && from && to) {
      // Pilot: IST (+05:30). A window ending at or before its start time ends the next day.
      const start = new Date(`${date}T${from}:00+05:30`);
      const end = new Date(`${date}T${to}:00+05:30`);
      if (end <= start) end.setDate(end.getDate() + 1);
      p.set('start', start.toISOString());
      p.set('end', end.toISOString());
    }
    if (type === 'PARKING') {
      if (filters.covered) p.set('covered', 'true');
      const security = [filters.cctv && 'CCTV', filters.guard && 'GUARD', filters.gated && 'GATED'].filter(
        Boolean,
      );
      if (security.length) p.set('security', security.join(','));
      if (filters.evReady) p.set('evReady', 'true');
      if (filters.vehicleClass) p.set('vehicleClass', filters.vehicleClass);
    } else {
      if (filters.connector) p.set('connectors', filters.connector);
      if (filters.minPowerKw) p.set('minPowerKw', filters.minPowerKw);
      if (currentType) p.set('currentType', currentType);
    }
    if (cursor) p.set('cursor', cursor);
    return p;
  }

  async function run(options: { append?: boolean; radius?: number } = {}) {
    const params = buildParams(options.append ? (nextCursor ?? undefined) : undefined, options.radius);
    if (!params) {
      setError('Choose a place or use your location first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<SearchResponse>(`/api/v1/listings/search?${params}`);
      setResults((prev) => (options.append && prev ? [...prev, ...res.results] : res.results));
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Search failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Natural-language search (Phase 22): the AI only fills in this form; the regular search decides what's available.
  async function describeSearch(event: FormEvent) {
    event.preventDefault();
    if (aiText.trim().length < 3) return;
    setAiBusy(true);
    setAiError(null);
    setFeedbackSent(false);
    try {
      const answer = await apiRequest<AiAnswer>('/api/v1/ai/search-intent', {
        method: 'POST',
        body: { text: aiText.trim() },
      });
      const f = answer.filters;
      setAi(answer);
      setType(f.type);
      setMode(f.mode && (f.type === 'PARKING' ? f.mode !== 'CHARGING_SESSION' : false) ? f.mode : '');
      setDate(f.date ?? '');
      setFrom(f.from ?? '');
      setTo(f.to ?? '');
      setMaxPrice(f.maxPricePaise != null ? String(f.maxPricePaise / 100) : '');
      setCurrentType(f.currentType ?? '');
      setFilters({
        covered: f.covered,
        cctv: f.security.includes('CCTV'),
        guard: f.security.includes('GUARD'),
        gated: f.security.includes('GATED'),
        evReady: f.evReady,
        vehicleClass: f.vehicleClass ?? '',
        connector: f.connector ?? '',
        minPowerKw: f.minPowerKw != null ? String(f.minPowerKw) : '',
      });
      setResults(null);
      if (f.place) {
        setPlace(f.place);
        setQuery(f.place.name);
        setPredictions([]);
      } else if (f.useMyLocation) {
        locateMe();
      }
      if (f.place || f.useMyLocation) setPendingRun(true);
    } catch (e) {
      setAiError(
        e instanceof ApiError ? e.userMessage : "We couldn't read that. Use the filters below instead.",
      );
    } finally {
      setAiBusy(false);
    }
  }

  // Search once the form reflects the interpreted request (and the device location, if asked for, has arrived);
  // run() reads the state this effect waits for.
  useEffect(() => {
    if (!pendingRun || !place) return;
    setPendingRun(false);
    void run();
  }, [pendingRun, place]);

  async function sendFeedback(helpful: boolean) {
    if (!ai) return;
    setFeedbackSent(true);
    await apiRequest(`/api/v1/ai/search-intent/${ai.id}/feedback`, {
      method: 'POST',
      body: { helpful },
    }).catch(() => undefined);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void run();
  }

  // Carry the chosen window to the listing so its booking box starts there (C-04 → C-05).
  const listingHref = (id: string) => {
    const q = new URLSearchParams();
    if (place) {
      q.set('lat', String(place.latitude));
      q.set('lng', String(place.longitude));
    }
    if (mode) q.set('mode', mode);
    if (date) q.set('date', date);
    if (from && to) {
      q.set('from', from);
      q.set('to', to);
    }
    const qs = q.toString();
    return qs ? `/listings/${id}?${qs}` : `/listings/${id}`;
  };

  return (
    <div className="search-layout">
      <div className="search-head">
        <h1>Find {type === 'PARKING' ? 'parking' : 'EV charging'} near you</h1>
        <p className="muted">
          Real availability from hosts nearby. Exact addresses are shared after you book.
        </p>
      </div>
      <div className="search-panel">
        <form onSubmit={describeSearch} className="describe" aria-label="Search by description">
          <div className="field">
            <label htmlFor="describe">Describe what you need</label>
            <input
              id="describe"
              maxLength={300}
              placeholder="e.g. covered parking near Indiranagar tomorrow 9am to 6pm under ₹60"
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
            />
            <p className="hint">
              We fill in the search for you. Don&apos;t include phone numbers or other personal details.
            </p>
          </div>
          <button type="submit" disabled={aiBusy || aiText.trim().length < 3}>
            {aiBusy ? 'Reading…' : 'Fill in the search'}
          </button>
          <FormError message={aiError} />
          {ai ? (
            <div className="understood" aria-live="polite">
              <p className="small muted">We understood:</p>
              <ul className="chips">
                {ai.chips.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {ai.notes.map((n) => (
                <p key={n} className="small muted">
                  {n}
                </p>
              ))}
              <p className="small">
                {feedbackSent ? (
                  'Thanks for the feedback.'
                ) : (
                  <>
                    Did we get it right?{' '}
                    <button type="button" className="link" onClick={() => void sendFeedback(true)}>
                      Yes
                    </button>{' '}
                    <button type="button" className="link" onClick={() => void sendFeedback(false)}>
                      No
                    </button>
                  </>
                )}
              </p>
            </div>
          ) : null}
        </form>
        <form onSubmit={onSubmit} className="search-form" noValidate>
          <div className="field combobox">
            <label htmlFor="where">Where?</label>
            <input
              id="where"
              role="combobox"
              aria-expanded={predictions.length > 0}
              aria-controls="where-options"
              aria-autocomplete="list"
              autoComplete="off"
              placeholder="Area or landmark, e.g. Koramangala"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPlace(null);
              }}
            />
            {predictions.length > 0 ? (
              <ul id="where-options" role="listbox" className="options">
                {predictions.map((p) => (
                  <li key={p.placeId} role="option" aria-selected="false">
                    <button type="button" className="option" onClick={() => void choose(p)}>
                      <strong>{p.primaryText}</strong> <span className="muted small">{p.secondaryText}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="link" onClick={locateMe}>
              Use my location
            </button>
          </div>

          <fieldset className="segmented">
            <legend>What do you need?</legend>
            {(['PARKING', 'EV_CHARGING'] as const).map((t) => (
              <label key={t} className={type === t ? 'active' : undefined}>
                <input
                  type="radio"
                  name="type"
                  value={t}
                  checked={type === t}
                  onChange={() => {
                    setType(t);
                    if (t === 'EV_CHARGING') void preferMyConnector();
                    setMode('');
                    setSort('distance');
                    setResults(null);
                  }}
                />
                {t === 'PARKING' ? 'Parking' : 'EV charging'}
              </label>
            ))}
          </fieldset>

          <div className="grid">
            {type === 'PARKING' ? (
              <div className="field">
                <label htmlFor="mode">Booking type</label>
                <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="">Any</option>
                  {PARKING_MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABEL[m]}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="date">Date (optional)</label>
              <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="from">From</label>
              <input id="from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="to">Until</label>
              <input id="to" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <details className="filters">
            <summary>Filters</summary>
            {type === 'PARKING' ? (
              <div className="checks">
                {(
                  [
                    ['covered', 'Covered'],
                    ['cctv', 'CCTV'],
                    ['guard', 'Guard'],
                    ['gated', 'Gated'],
                    ['evReady', 'EV-ready socket'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="check">
                    <input
                      type="checkbox"
                      checked={filters[key]}
                      onChange={(e) => setFilters({ ...filters, [key]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
                <div className="field">
                  <label htmlFor="vehicle">My vehicle</label>
                  <select
                    id="vehicle"
                    value={filters.vehicleClass}
                    onChange={(e) => setFilters({ ...filters, vehicleClass: e.target.value })}
                  >
                    <option value="">Any size</option>
                    {Object.entries(VEHICLE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid">
                <div className="field">
                  <label htmlFor="connector">Connector</label>
                  {fitsVehicle && filters.connector ? (
                    <p className="hint">Showing chargers that fit {fitsVehicle}.</p>
                  ) : null}
                  <select
                    id="connector"
                    value={filters.connector}
                    onChange={(e) => setFilters({ ...filters, connector: e.target.value })}
                  >
                    <option value="">Any</option>
                    {Object.entries(CONNECTOR_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="current">Charging</label>
                  <select id="current" value={currentType} onChange={(e) => setCurrentType(e.target.value)}>
                    <option value="">AC or DC</option>
                    <option value="AC">AC (slower)</option>
                    <option value="DC">DC (fast)</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="power">Minimum power (kW)</label>
                  <input
                    id="power"
                    inputMode="decimal"
                    value={filters.minPowerKw}
                    onChange={(e) => setFilters({ ...filters, minPowerKw: e.target.value })}
                  />
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="max-price">
                Max price (₹ per {type === 'EV_CHARGING' ? 'session hour' : (MODE_UNIT[mode] ?? 'hour')})
              </label>
              <input
                id="max-price"
                inputMode="numeric"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="field">
              <label htmlFor="sort">Sort by</label>
              <select
                id="sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as 'distance' | 'price')}
              >
                <option value="distance">Nearest</option>
                <option value="price" disabled={type === 'PARKING' && !mode}>
                  Lowest price{type === 'PARKING' && !mode ? ' (choose a booking type)' : ''}
                </option>
              </select>
            </div>
          </details>

          <FormError message={error} />
          <button type="submit" disabled={busy}>
            {busy && !results ? 'Searching…' : 'Search'}
          </button>
        </form>
      </div>

      <section aria-live="polite" aria-busy={busy} className="results">
        {results === null ? (
          <div className="results-placeholder">
            <SearchIcon size={28} />
            <p>
              <strong>Where are you headed?</strong>
            </p>
            <p className="muted small">
              Choose a place or describe what you need, and spots nearby will appear here.
            </p>
          </div>
        ) : results.length === 0 ? (
          <div className="empty">
            <h2>No spots found near {place?.name ?? 'there'}</h2>
            <p className="muted">Try a wider area{date ? ', a different time' : ''} or fewer filters.</p>
            {radiusM < 10_000 ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setRadiusM(10_000);
                  void run({ radius: 10_000 });
                }}
              >
                Search within 10 km
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <h2 className="visually-hidden">Results</h2>
            <p className="results-count">
              <strong>
                {results.length}
                {nextCursor ? '+' : ''} {results.length === 1 ? 'spot' : 'spots'}
              </strong>{' '}
              <span className="muted">near {place?.name ?? 'you'}</span>
            </p>
            <ul className="cards">
              {results.map((r) => (
                <li key={r.id} className="card">
                  <Link href={listingHref(r.id)} className="card-link">
                    {r.photo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- see listings/[id]/page.tsx (D-098)
                      <img
                        src={r.photo.url}
                        alt=""
                        width={r.photo.width}
                        height={r.photo.height}
                        loading="lazy"
                        decoding="async"
                        className="card-photo"
                      />
                    ) : (
                      <div className="card-photo placeholder" />
                    )}
                    <div className="card-body">
                      <h3>{r.title}</h3>
                      <p className="muted small">
                        {r.areaLabel} · {formatDistance(r.distanceM)}
                      </p>
                      <p className="price">{formatPrice(r.price.pricePaise, r.price.unit)}</p>
                      <p className="badges small">
                        {r.charger
                          ? `${r.charger.connectors.map((c) => CONNECTOR_LABEL[c] ?? c).join(', ')} · ${r.charger.currentType} ${r.charger.powerKw} kW`
                          : [
                              r.covered ? 'Covered' : 'Open',
                              ...r.security.map((s) =>
                                s === 'CCTV' ? 'CCTV' : s[0] + s.slice(1).toLowerCase(),
                              ),
                              `Fits ${VEHICLE_LABEL[r.maxVehicleClass] ?? r.maxVehicleClass}`,
                            ].join(' · ')}
                        {r.approvalRequired ? ' · Host approves requests' : ''}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {nextCursor ? (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void run({ append: true })}
              >
                {busy ? 'Loading…' : 'Show more'}
              </button>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
