import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CONNECTOR_LABEL,
  chargingSpeed,
  LEVEL_LABEL,
  MODE_LABEL,
  VEHICLE_LABEL,
  formatDistance,
  formatPrice,
  formatWeekdays,
  formatWindow,
} from '../../../lib/format';
import { BookingPanel } from './booking-panel';

interface PublicListing {
  id: string;
  type: 'PARKING' | 'EV_CHARGING';
  title: string;
  description: string;
  rulesText: string;
  areaLabel: string;
  societyName: string | null;
  location: { latitude: number; longitude: number; precision: 'AREA' | 'PIN'; radiusM: number };
  distanceM: number | null;
  host: { name: string; since: string };
  spaces: number | null;
  parking: {
    covered: boolean;
    level: string;
    maxVehicleClass: string;
    heightCm: number | null;
    lengthCm: number | null;
    security: string[];
    lighting: boolean;
    evReadySocket: boolean;
    tandem: boolean;
  };
  charger: { connectors: string[]; currentType: string; powerKw: number; cableProvided: boolean } | null;
  rates: {
    mode: string;
    unit: string;
    pricePaise: number;
    overnightStart: string | null;
    overnightEnd: string | null;
  }[];
  photos: { url: string; kind: string; width: number; height: number }[];
  schedule: { weekdays: number[]; startLocal: string; endLocal: string }[];
  booking: {
    approvalRequired: boolean;
    minMinutes: number;
    maxMinutes: number;
    leadMinutes: number;
    cancellationPolicy: string;
  };
}

const API =
  process.env.API_INTERNAL_URL ??
  (process.env.API_INTERNAL_HOSTPORT
    ? `http://${process.env.API_INTERNAL_HOSTPORT}`
    : 'http://127.0.0.1:4101');

async function loadListing(
  id: string,
  search: { lat?: string; lng?: string },
): Promise<PublicListing | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const qs =
    search.lat && search.lng
      ? `?lat=${encodeURIComponent(search.lat)}&lng=${encodeURIComponent(search.lng)}`
      : '';
  const res = await fetch(`${API}/api/v1/listings/${id}${qs}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`listing request failed: ${res.status}`);
  return (await res.json()) as PublicListing;
}

interface PublicReviews {
  count: number;
  average: number | null;
  items: { rating: number; body: string | null; author: string; month: string }[];
}

async function loadReviews(id: string): Promise<PublicReviews | null> {
  const res = await fetch(`${API}/api/v1/listings/${id}/reviews`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  return res.ok ? ((await res.json()) as PublicReviews) : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const listing = await loadListing((await params).id, {});
  return { title: listing ? `${listing.title} · ${listing.areaLabel}` : 'Listing not found' };
}

const CANCELLATION: Record<string, string> = {
  FLEXIBLE: 'Flexible',
  MODERATE: 'Moderate',
  STRICT: 'Strict',
};

/** Public listing (ux-architecture C-04). Exact location and access details are shown only after booking (L-6). */
export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    lat?: string;
    lng?: string;
    mode?: string;
    date?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const query = await searchParams;
  const listing = await loadListing((await params).id, query);
  if (!listing) notFound();
  const reviews = await loadReviews(listing.id);
  const p = listing.parking;
  const since = new Date(listing.host.since).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <main className="page wide">
      <p className="back-link">
        <Link href="/search">← Back to search</Link>
      </p>
      <p className="tag-row">
        <span className={listing.type === 'EV_CHARGING' ? 'tag ev' : 'tag'}>
          {listing.type === 'EV_CHARGING' ? 'EV charging' : 'Parking'}
        </span>
        {listing.booking.approvalRequired ? <span className="tag neutral">Request to book</span> : null}
        {reviews && reviews.count > 0 && reviews.average !== null ? (
          <span className="tag neutral">★ {reviews.average}</span>
        ) : null}
      </p>
      <h1>{listing.title}</h1>
      <p className="muted listing-place">
        {listing.societyName ? `${listing.societyName}, ` : ''}
        {listing.areaLabel}
        {listing.distanceM !== null ? ` · ${formatDistance(listing.distanceM)}` : ''}
      </p>
      {listing.location.precision === 'AREA' ? (
        <p className="notice small">
          Approximate area shown. The exact address and entry details are shared after you book.
        </p>
      ) : null}

      {listing.photos.length > 0 ? (
        <div className="gallery">
          {listing.photos.map((photo, i) => (
            // Plain <img>: next/image always emits style="color:transparent", which the nonce CSP blocks (D-098).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={photo.url}
              src={photo.url}
              alt={i === 0 ? `Photo of ${listing.title}` : ''}
              width={photo.width}
              height={photo.height}
              loading={i === 0 ? 'eager' : 'lazy'}
              fetchPriority={i === 0 ? 'high' : 'auto'}
              decoding="async"
              className={i === 0 ? 'gallery-main' : 'gallery-thumb'}
            />
          ))}
        </div>
      ) : null}

      <div className="listing-layout">
        <div>
          {listing.description ? <p>{listing.description}</p> : null}

          <h2>The space</h2>
          <ul className="facts">
            <li>
              {p.covered ? 'Covered' : 'Open'} · {LEVEL_LABEL[p.level] ?? p.level}
            </li>
            <li>Fits up to {VEHICLE_LABEL[p.maxVehicleClass] ?? p.maxVehicleClass}</li>
            {p.heightCm ? <li>Height limit {(p.heightCm / 100).toFixed(2)} m</li> : null}
            {p.lengthCm ? <li>Length {(p.lengthCm / 100).toFixed(1)} m</li> : null}
            {p.security.length ? (
              <li>
                Security:{' '}
                {p.security.map((s) => (s === 'CCTV' ? 'CCTV' : s[0] + s.slice(1).toLowerCase())).join(', ')}
              </li>
            ) : null}
            {p.lighting ? <li>Well lit</li> : null}
            {p.evReadySocket ? <li>EV-ready socket</li> : null}
            {p.tandem ? <li>Tandem space (may need to coordinate with another car)</li> : null}
            {listing.spaces !== null ? <li>{listing.spaces} spaces</li> : null}
          </ul>

          {listing.charger ? (
            <>
              <h2>The charger</h2>
              <ul className="facts">
                <li>
                  {listing.charger.connectors.map((c) => CONNECTOR_LABEL[c] ?? c).join(', ')} ·{' '}
                  {listing.charger.currentType} {listing.charger.powerKw} kW
                </li>
                <li>{chargingSpeed(listing.charger.currentType, listing.charger.powerKw)}</li>
                <li>{listing.charger.cableProvided ? 'Cable provided' : 'Bring your own cable'}</li>
                <li>Parking included while you charge</li>
              </ul>
            </>
          ) : null}

          <h2>When it&apos;s available</h2>
          <ul className="facts">
            {listing.schedule.map((s, i) => (
              <li key={i}>
                {formatWeekdays(s.weekdays)}, {formatWindow(s.startLocal, s.endLocal)}
              </li>
            ))}
          </ul>

          {listing.rulesText ? (
            <>
              <h2>House rules</h2>
              <p>{listing.rulesText}</p>
            </>
          ) : null}

          {reviews && reviews.count > 0 ? (
            <>
              <h2>
                Reviews{reviews.average !== null ? ` · ★ ${reviews.average}` : ''} ({reviews.count})
              </h2>
              <ul className="list">
                {reviews.items.slice(0, 5).map((r, i) => (
                  <li key={i}>
                    <span>
                      {'★'.repeat(r.rating)}
                      {'☆'.repeat(5 - r.rating)} {r.body ? `“${r.body}”` : ''}
                    </span>
                    <span className="small muted">
                      {r.author}, {r.month}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="muted small">
            Hosted by {listing.host.name} · on ParkBro since {since}
          </p>
        </div>

        <aside className="booking-box" aria-label="Prices and booking">
          <h2>Prices</h2>
          <table className="prices">
            <tbody>
              {listing.rates.map((r) => (
                <tr key={r.mode}>
                  <th scope="row">
                    {MODE_LABEL[r.mode] ?? r.mode}
                    {r.overnightStart && r.overnightEnd ? (
                      <span className="muted small">
                        {' '}
                        ({r.overnightStart}–{r.overnightEnd})
                      </span>
                    ) : null}
                  </th>
                  <td>{formatPrice(r.pricePaise, r.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            Cancellation:{' '}
            {CANCELLATION[listing.booking.cancellationPolicy] ?? listing.booking.cancellationPolicy}
          </p>
          {listing.booking.approvalRequired ? (
            <p className="small muted">The host approves each request.</p>
          ) : null}
          <BookingPanel
            assetId={listing.id}
            rates={listing.rates}
            isCharger={listing.type === 'EV_CHARGING'}
            defaults={{ mode: query.mode, date: query.date, from: query.from, to: query.to }}
            searchHref="/search"
          />
        </aside>
      </div>
    </main>
  );
}
