import { sql, type Kysely, type RawBuilder } from 'kysely';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import { assetCheck, type ReservationSource, type UnavailableReason } from '../../availability/index.ts';
import {
  decodeCursor,
  encodeCursor,
  isAfter,
  queryFingerprint,
  type CursorPosition,
} from '../domain/cursor.ts';
import {
  MODE_PREFERENCE,
  VEHICLE_ORDER,
  locationPrecision,
  publicHostName,
  publicSpaceCount,
  roundCoordinate,
  roundDistance,
  type PropertyKind,
  type VehicleClass,
} from '../domain/presentation.ts';
import type { DiscoveryDb } from '../infrastructure/views.ts';

/** Upper bound of candidates per search before in-app filtering (pilot scale; see database-design §5). */
const MAX_CANDIDATES = 500;

export type ListingType = 'PARKING' | 'EV_CHARGING';
export type SearchMode = 'HOURLY' | 'DAILY' | 'OVERNIGHT' | 'MONTHLY' | 'CHARGING_SESSION';

export interface SearchQuery {
  latitude: number;
  longitude: number;
  radiusM: number;
  type: ListingType;
  mode?: SearchMode | undefined;
  start?: Date | undefined;
  end?: Date | undefined;
  maxPricePaise?: number | undefined;
  covered?: boolean | undefined;
  security?: ('CCTV' | 'GUARD' | 'GATED')[] | undefined;
  evReady?: boolean | undefined;
  vehicleClass?: VehicleClass | undefined;
  connectors?: string[] | undefined;
  currentType?: 'AC' | 'DC' | undefined;
  minPowerKw?: number | undefined;
  sort: 'distance' | 'price';
  cursor?: string | undefined;
  limit: number;
}

export const discoveryErrors = {
  invalidCursor: () =>
    new DomainError({
      code: 'discovery.invalid_cursor',
      status: 400,
      title: 'This page link has expired',
      detail: 'Run the search again.',
    }),
  invalidQuery: (detail: string) =>
    new DomainError({ code: 'request.invalid', status: 400, title: 'Invalid request', detail }),
};

const origin = (lat: number, lng: number) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;

export type WindowVerdict =
  { available: true } | { available: false; reason: UnavailableReason | 'LEAD_TIME' | 'DURATION' };

interface WindowContext {
  id: string;
  timezone: string;
  lead_minutes: number;
  min_minutes: number;
  max_minutes: number;
  buffer_minutes: number;
}

export function createDiscoveryService(deps: {
  db: Kysely<DiscoveryDb>;
  reservations: ReservationSource;
  now?: () => number;
}) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  /**
   * Deterministic availability for listings over [start, end) (Phase 11 engine): weekly rules, host blocks and
   * openings, holding reservations with buffers, per unit; plus lead time and, for hourly-type modes, duration
   * limits (BR-13). Returns a verdict per listing id.
   */
  async function evaluateWindows(
    listings: WindowContext[],
    start: number,
    end: number,
    mode: SearchMode | undefined,
  ) {
    const verdicts = new Map<string, WindowVerdict>();
    if (listings.length === 0) return verdicts;
    const ids = listings.map((l) => l.id);
    const [rules, units, exceptions] = await Promise.all([
      db
        .selectFrom('discovery.published_availability_rules')
        .select(['asset_id', 'weekdays', 'start_local', 'end_local', 'valid_from', 'valid_to'])
        .where('asset_id', 'in', ids)
        .execute(),
      db
        .selectFrom('discovery.published_units')
        .select(['asset_id', 'unit_id'])
        .where('asset_id', 'in', ids)
        .orderBy('unit_id')
        .execute(),
      db
        .selectFrom('discovery.published_availability_exceptions')
        .select([
          'id',
          'asset_id',
          'unit_id',
          'kind',
          sql<number>`extract(epoch FROM lower(period)) * 1000`.as('start_ms'),
          sql<number>`extract(epoch FROM upper(period)) * 1000`.as('end_ms'),
        ])
        .where('asset_id', 'in', ids)
        .where(
          sql<boolean>`period && tstzrange(to_timestamp(${start / 1000}), to_timestamp(${end / 1000}), '[)')`,
        )
        .execute(),
    ]);
    // Reservations matter up to `end + buffer` (the new booking's own turnover gap).
    const maxBuffer = Math.max(...listings.map((l) => l.buffer_minutes)) * 60_000;
    const reservations = await deps.reservations.holdingReservations(
      units.map((u) => u.unit_id),
      start,
      end + maxBuffer,
    );
    const rulesBy = Map.groupBy(rules, (r) => r.asset_id);
    const unitsBy = Map.groupBy(units, (u) => u.asset_id);
    const exceptionsBy = Map.groupBy(exceptions, (e) => e.asset_id);
    const durationMinutes = (end - start) / 60_000;
    const durationLimited = mode === 'HOURLY' || mode === 'CHARGING_SESSION';

    for (const l of listings) {
      if (start < now() + l.lead_minutes * 60_000) {
        verdicts.set(l.id, { available: false, reason: 'LEAD_TIME' });
        continue;
      }
      if (durationLimited && (durationMinutes < l.min_minutes || durationMinutes > l.max_minutes)) {
        verdicts.set(l.id, { available: false, reason: 'DURATION' });
        continue;
      }
      const unitIds = (unitsBy.get(l.id) ?? []).map((u) => u.unit_id);
      const unitSet = new Set(unitIds);
      const result = assetCheck(
        {
          timezone: l.timezone,
          bufferMinutes: l.buffer_minutes,
          unitIds,
          rules: (rulesBy.get(l.id) ?? []).map((r) => ({
            weekdays: r.weekdays,
            startLocal: r.start_local.slice(0, 5),
            endLocal: r.end_local.slice(0, 5),
            validFrom: String(r.valid_from),
            validTo: r.valid_to === null ? null : String(r.valid_to),
          })),
          exceptions: (exceptionsBy.get(l.id) ?? []).map((e) => ({
            id: e.id,
            unitId: e.unit_id,
            kind: e.kind as 'BLOCK' | 'OPEN',
            start: Number(e.start_ms),
            end: Number(e.end_ms),
          })),
          reservations: reservations.filter((r) => unitSet.has(r.unitId)),
        },
        start,
        end,
      );
      verdicts.set(
        l.id,
        result.available ? { available: true } : { available: false, reason: result.reason },
      );
    }
    return verdicts;
  }

  function validate(q: SearchQuery) {
    if ((q.start === undefined) !== (q.end === undefined))
      throw discoveryErrors.invalidQuery('Send start and end together.');
    if (q.start && q.end) {
      if (q.end <= q.start) throw discoveryErrors.invalidQuery('end must be after start.');
      if (q.end.getTime() - q.start.getTime() > 35 * 86_400_000)
        throw discoveryErrors.invalidQuery('Search windows are limited to 35 days.');
    }
    if (q.maxPricePaise !== undefined && q.mode === undefined)
      throw discoveryErrors.invalidQuery('maxPricePaise needs a booking mode.');
    if (q.sort === 'price' && q.mode === undefined)
      throw discoveryErrors.invalidQuery('Sorting by price needs a booking mode.');
    if (q.type === 'PARKING' && q.mode === 'CHARGING_SESSION')
      throw discoveryErrors.invalidQuery('CHARGING_SESSION is for EV charging.');
    if (q.type === 'EV_CHARGING' && q.mode && q.mode !== 'CHARGING_SESSION')
      throw discoveryErrors.invalidQuery('EV charging is booked by session.');
    const evFilters = q.connectors !== undefined || q.currentType !== undefined || q.minPowerKw !== undefined;
    if (q.type === 'PARKING' && evFilters)
      throw discoveryErrors.invalidQuery('Charger filters apply to EV charging.');
  }

  async function search(q: SearchQuery) {
    validate(q);
    const { cursor: _c, limit: _l, ...fingerprinted } = q;
    const fingerprint = queryFingerprint({
      ...fingerprinted,
      start: q.start?.toISOString(),
      end: q.end?.toISOString(),
    });
    const cursor = q.cursor ? decodeCursor(q.cursor, fingerprint) : null;
    if (q.cursor && !cursor) throw discoveryErrors.invalidCursor();

    const point = origin(q.latitude, q.longitude);
    const filters: RawBuilder<unknown>[] = [
      sql`ST_DWithin(l.public_point, ${point}, ${q.radiusM})`,
      sql`l.asset_type = ${q.type}`,
      sql`hp.mode IS NOT NULL`,
    ];
    if (q.maxPricePaise !== undefined) filters.push(sql`hp.price_paise <= ${q.maxPricePaise}`);
    if (q.covered) filters.push(sql`l.covered`);
    if (q.security?.length) filters.push(sql`l.security @> ${sql.val(q.security)}::text[]`);
    if (q.evReady) filters.push(sql`l.ev_ready_socket`);
    if (q.vehicleClass) {
      const fitting = VEHICLE_ORDER.slice(VEHICLE_ORDER.indexOf(q.vehicleClass));
      filters.push(sql`l.max_vehicle_class = ANY(${sql.val(fitting)}::text[])`);
    }
    if (q.connectors?.length) filters.push(sql`l.connectors && ${sql.val(q.connectors)}::text[]`);
    if (q.currentType) filters.push(sql`l.current_type = ${q.currentType}`);
    if (q.minPowerKw !== undefined) filters.push(sql`l.power_kw >= ${q.minPowerKw}`);

    const modeOrder = sql.val([...MODE_PREFERENCE]);
    const rateFilter = q.mode ? sql`r.mode = ${q.mode}` : sql`true`;
    const orderBy = q.sort === 'price' ? sql`hp.price_paise, distance_m, l.id` : sql`distance_m, l.id`;

    const rows = await sql<{
      id: string;
      title: string;
      area_label: string;
      property_kind: PropertyKind;
      timezone: string;
      covered: boolean;
      security: string[];
      ev_ready_socket: boolean;
      max_vehicle_class: VehicleClass;
      connectors: string[] | null;
      current_type: 'AC' | 'DC' | null;
      power_kw: string | null;
      min_minutes: number;
      max_minutes: number;
      lead_minutes: number;
      buffer_minutes: number;
      approval_required: boolean;
      distance_m: number;
      lat: number;
      lng: number;
      price_mode: SearchMode;
      price_unit: string;
      price_paise: string;
      photo_id: string | null;
      photo_width: number | null;
      photo_height: number | null;
    }>`
      SELECT l.id, l.title, l.area_label, l.property_kind, l.timezone, l.covered, l.security, l.ev_ready_socket,
             l.max_vehicle_class, l.connectors, l.current_type, l.power_kw, l.min_minutes, l.max_minutes,
             l.lead_minutes, l.buffer_minutes, l.approval_required,
             ST_Distance(l.public_point, ${point}) AS distance_m,
             ST_Y(l.public_point::geometry) AS lat, ST_X(l.public_point::geometry) AS lng,
             hp.mode AS price_mode, hp.unit AS price_unit, hp.price_paise,
             ph.id AS photo_id, ph.width AS photo_width, ph.height AS photo_height
      FROM discovery.published_listings l
      LEFT JOIN LATERAL (
        SELECT r.mode, r.unit, r.price_paise FROM discovery.published_rates r
        WHERE r.asset_id = l.id AND ${rateFilter}
        ORDER BY array_position(${modeOrder}::text[], r.mode) LIMIT 1
      ) hp ON true
      LEFT JOIN LATERAL (
        SELECT p.id, p.width, p.height FROM discovery.public_photos p
        WHERE p.asset_id = l.id ORDER BY (p.kind = 'SLOT') DESC, p.position, p.created_at LIMIT 1
      ) ph ON true
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY ${orderBy}
      LIMIT ${MAX_CANDIDATES}`.execute(db);

    let candidates = rows.rows;

    // Real availability (Phase 11 engine): rules, blocks/openings, reservations with buffers, lead time, duration.
    if (q.start && q.end && candidates.length > 0) {
      const verdicts = await evaluateWindows(candidates, q.start.getTime(), q.end.getTime(), q.mode);
      candidates = candidates.filter((c) => verdicts.get(c.id)?.available === true);
    }

    const keyOf = (c: (typeof candidates)[number]): CursorPosition => ({
      key: q.sort === 'price' ? [Number(c.price_paise), c.distance_m] : [c.distance_m],
      id: c.id,
    });
    const afterCursor = cursor ? candidates.filter((c) => isAfter(keyOf(c), cursor)) : candidates;
    const page = afterCursor.slice(0, q.limit);
    const last = page.at(-1);
    const nextCursor = afterCursor.length > q.limit && last ? encodeCursor(keyOf(last), fingerprint) : null;

    return {
      results: page.map((c) => ({
        id: c.id,
        type: q.type,
        title: c.title,
        areaLabel: c.area_label,
        distanceM: roundDistance(c.distance_m),
        location: {
          latitude: roundCoordinate(c.lat),
          longitude: roundCoordinate(c.lng),
          ...locationPrecision(c.property_kind),
        },
        price: { mode: c.price_mode, unit: c.price_unit, pricePaise: Number(c.price_paise) },
        photo: c.photo_id
          ? { url: `/api/v1/media/${c.photo_id}`, width: c.photo_width ?? 0, height: c.photo_height ?? 0 }
          : null,
        covered: c.covered,
        security: c.security,
        evReady: c.ev_ready_socket,
        maxVehicleClass: c.max_vehicle_class,
        approvalRequired: c.approval_required,
        charger:
          q.type === 'EV_CHARGING' && c.connectors && c.current_type && c.power_kw
            ? { connectors: c.connectors, currentType: c.current_type, powerKw: Number(c.power_kw) }
            : null,
      })),
      nextCursor,
      availabilityChecked: q.start !== undefined,
    };
  }

  async function listing(id: string, from: { latitude: number; longitude: number } | null) {
    const distance = from
      ? sql<number | null>`ST_Distance(l.public_point, ${origin(from.latitude, from.longitude)})`
      : sql<number | null>`NULL::float8`;
    const row = await db
      .selectFrom('discovery.published_listings as l')
      .selectAll()
      .select([
        sql<number>`ST_Y(l.public_point::geometry)`.as('lat'),
        sql<number>`ST_X(l.public_point::geometry)`.as('lng'),
        distance.as('distance_m'),
      ])
      .where('l.id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    const [rates, photos, rules] = await Promise.all([
      db.selectFrom('discovery.published_rates').selectAll().where('asset_id', '=', id).execute(),
      db
        .selectFrom('discovery.public_photos')
        .selectAll()
        .where('asset_id', '=', id)
        .orderBy('position')
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('discovery.published_availability_rules')
        .selectAll()
        .where('asset_id', '=', id)
        .execute(),
    ]);
    const kind = row.property_kind as PropertyKind;
    const precision = locationPrecision(kind);
    return {
      id: row.id,
      type: row.asset_type as ListingType,
      title: row.title,
      description: row.description,
      rulesText: row.rules_text,
      areaLabel: row.area_label,
      societyName: row.society_name,
      // The fuzzed public point (L-1); for residential listings the UI draws an area circle, never a pin (L-3).
      location: { latitude: roundCoordinate(row.lat), longitude: roundCoordinate(row.lng), ...precision },
      distanceM: row.distance_m === null ? null : roundDistance(row.distance_m),
      timezone: row.timezone,
      host: {
        name: publicHostName(row.host_display_name, row.host_kind as 'INDIVIDUAL' | 'BUSINESS'),
        since: row.host_since,
      },
      spaces: publicSpaceCount(kind, row.active_units),
      parking: {
        covered: row.covered,
        level: row.level,
        maxVehicleClass: row.max_vehicle_class,
        heightCm: row.height_cm,
        lengthCm: row.length_cm,
        security: row.security,
        lighting: row.lighting,
        evReadySocket: row.ev_ready_socket,
        tandem: row.tandem,
      },
      charger:
        row.asset_type === 'EV_CHARGING' && row.connectors && row.current_type && row.power_kw
          ? {
              connectors: row.connectors,
              currentType: row.current_type,
              powerKw: Number(row.power_kw),
              cableProvided: row.cable_provided ?? false,
            }
          : null,
      rates: rates
        .sort(
          (a, b) =>
            MODE_PREFERENCE.indexOf(a.mode as SearchMode) - MODE_PREFERENCE.indexOf(b.mode as SearchMode),
        )
        .map((r) => ({
          mode: r.mode,
          unit: r.unit,
          pricePaise: Number(r.price_paise),
          overnightStart: r.overnight_start?.slice(0, 5) ?? null,
          overnightEnd: r.overnight_end?.slice(0, 5) ?? null,
        })),
      photos: photos.map((p) => ({
        url: `/api/v1/media/${p.id}`,
        kind: p.kind,
        width: p.width,
        height: p.height,
      })),
      schedule: rules.map((r) => ({
        weekdays: r.weekdays,
        startLocal: r.start_local.slice(0, 5),
        endLocal: r.end_local.slice(0, 5),
      })),
      booking: {
        approvalRequired: row.approval_required,
        minMinutes: row.min_minutes,
        maxMinutes: row.max_minutes,
        leadMinutes: row.lead_minutes,
        cancellationPolicy: row.cancellation_policy_code,
      },
    };
  }

  /** Public "is this window bookable?" check for one listing (booking UI, C-04/C-05). */
  async function checkWindow(
    id: string,
    start: Date,
    end: Date,
    mode: SearchMode | undefined,
  ): Promise<WindowVerdict> {
    if (!(end > start)) return { available: false, reason: 'INVALID_WINDOW' };
    if (end.getTime() - start.getTime() > 35 * 86_400_000)
      throw discoveryErrors.invalidQuery('Windows are limited to 35 days.');
    const row = await db
      .selectFrom('discovery.published_listings')
      .select([
        'id',
        'timezone',
        'lead_minutes',
        'min_minutes',
        'max_minutes',
        'buffer_minutes',
        'asset_type',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    if (mode) {
      const hasMode = await db
        .selectFrom('discovery.published_rates')
        .select('mode')
        .where('asset_id', '=', id)
        .where('mode', '=', mode)
        .executeTakeFirst();
      if (!hasMode) throw discoveryErrors.invalidQuery('This listing does not offer that booking type.');
    }
    return (
      (await evaluateWindows([row], start.getTime(), end.getTime(), mode)).get(id) ?? {
        available: false,
        reason: 'CLOSED',
      }
    );
  }

  return { search, listing, checkWindow };
}

export type DiscoveryService = ReturnType<typeof createDiscoveryService>;
