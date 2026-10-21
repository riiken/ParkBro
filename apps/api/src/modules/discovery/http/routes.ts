import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DomainEventMap } from '../../../platform/events/domain-events.ts';

export type DiscoverySignal = <T extends 'discovery.searched' | 'discovery.listing_viewed'>(
  type: T,
  payload: DomainEventMap[T],
) => Promise<void>;
import type { KeyedHasher } from '../../../platform/crypto/keyed-hash.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import { coarsePoint, type Geocoder } from '../../../platform/providers/geocoding.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import type { DiscoveryService } from '../application/discovery-service.ts';
import { VEHICLE_ORDER } from '../domain/presentation.ts';

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)).max(values.length));
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const location = z.object({
  latitude: z.number(),
  longitude: z.number(),
  precision: z.enum(['AREA', 'PIN']),
  radiusM: z.number(),
});

const searchResult = z.object({
  id: z.uuid(),
  type: z.enum(['PARKING', 'EV_CHARGING']),
  title: z.string(),
  areaLabel: z.string(),
  distanceM: z.number().int(),
  // Public (fuzzed, ~110 m-rounded) point, the same one the listing page shows (D-075, D-174).
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
    precision: z.enum(['AREA', 'PIN']),
    radiusM: z.number(),
  }),
  price: z.object({ mode: z.string(), unit: z.string(), pricePaise: z.number().int() }),
  photo: z.object({ url: z.string(), width: z.number().int(), height: z.number().int() }).nullable(),
  covered: z.boolean(),
  security: z.array(z.string()),
  evReady: z.boolean(),
  maxVehicleClass: z.string(),
  approvalRequired: z.boolean(),
  charger: z
    .object({ connectors: z.array(z.string()), currentType: z.string(), powerKw: z.number() })
    .nullable(),
});

const listingView = z.object({
  id: z.uuid(),
  type: z.enum(['PARKING', 'EV_CHARGING']),
  title: z.string(),
  description: z.string(),
  rulesText: z.string(),
  areaLabel: z.string(),
  societyName: z.string().nullable(),
  location,
  distanceM: z.number().int().nullable(),
  timezone: z.string(),
  host: z.object({ name: z.string(), since: z.date() }),
  spaces: z.number().int().nullable(),
  parking: z.object({
    covered: z.boolean(),
    level: z.string(),
    maxVehicleClass: z.string(),
    heightCm: z.number().int().nullable(),
    lengthCm: z.number().int().nullable(),
    security: z.array(z.string()),
    lighting: z.boolean(),
    evReadySocket: z.boolean(),
    tandem: z.boolean(),
  }),
  charger: z
    .object({
      connectors: z.array(z.string()),
      currentType: z.string(),
      powerKw: z.number(),
      cableProvided: z.boolean(),
    })
    .nullable(),
  rates: z.array(
    z.object({
      mode: z.string(),
      unit: z.string(),
      pricePaise: z.number().int(),
      overnightStart: z.string().nullable(),
      overnightEnd: z.string().nullable(),
    }),
  ),
  photos: z.array(
    z.object({ url: z.string(), kind: z.string(), width: z.number().int(), height: z.number().int() }),
  ),
  schedule: z.array(
    z.object({ weekdays: z.array(z.number().int()), startLocal: z.string(), endLocal: z.string() }),
  ),
  booking: z.object({
    approvalRequired: z.boolean(),
    minMinutes: z.number().int(),
    maxMinutes: z.number().int(),
    leadMinutes: z.number().int(),
    cancellationPolicy: z.string(),
  }),
});

/** Public, anonymous discovery (ux-architecture C-01–C-04). Read-only over discovery.* views. */
export const discoveryRoutes: FastifyPluginAsync<{
  discovery: DiscoveryService;
  geocoder: Geocoder;
  rateLimiter: RateLimiter;
  hasher: KeyedHasher;
  signal: DiscoverySignal;
}> = async (app, { discovery, geocoder, rateLimiter, hasher, signal }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limit = (request: FastifyRequest, bucket: string, perMinute: number) =>
    rateLimiter.enforce({
      key: `${bucket}:ip1m:${hasher.hash('discovery.rate_limit_ip', request.ip).toString('hex').slice(0, 32)}`,
      limit: perMinute,
      windowSeconds: 60,
    });

  r.get(
    '/v1/listings/search',
    {
      schema: {
        tags: ['discovery'],
        querystring: z.object({
          lat,
          lng,
          radiusM: z.coerce.number().int().min(100).max(10_000).default(3000),
          type: z.enum(['PARKING', 'EV_CHARGING']),
          mode: z.enum(['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION']).optional(),
          start: z.iso.datetime({ offset: true }).optional(),
          end: z.iso.datetime({ offset: true }).optional(),
          maxPricePaise: z.coerce.number().int().min(100).max(10_000_000).optional(),
          covered: bool.optional(),
          security: csv(['CCTV', 'GUARD', 'GATED']).optional(),
          evReady: bool.optional(),
          vehicleClass: z.enum(VEHICLE_ORDER).optional(),
          connectors: csv(['TYPE2', 'CCS2', 'BHARAT_AC001', 'BHARAT_DC001', 'IEC_15A', 'GBT']).optional(),
          currentType: z.enum(['AC', 'DC']).optional(),
          minPowerKw: z.coerce.number().positive().max(400).optional(),
          sort: z.enum(['distance', 'price']).default('distance'),
          cursor: z.string().max(400).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: {
          200: z.object({
            results: z.array(searchResult),
            nextCursor: z.string().nullable(),
            availabilityChecked: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      await limit(request, 'search', 60);
      const q = request.query;
      const result = await discovery.search({
        ...q,
        latitude: q.lat,
        longitude: q.lng,
        start: q.start ? new Date(q.start) : undefined,
        end: q.end ? new Date(q.end) : undefined,
      });
      // Liquidity signal (R-01: zero-result searches) without PII: ~1 km grid cell, no IP, no user.
      await signal('discovery.searched', {
        cell: `${q.lat.toFixed(2)},${q.lng.toFixed(2)}`,
        areaLabel: result.results[0]?.areaLabel ?? null,
        assetType: q.type,
        mode: q.mode ?? null,
        windowed: q.start !== undefined,
        resultCount: result.results.length,
        firstPage: q.cursor === undefined,
      });
      return result;
    },
  );

  r.get(
    '/v1/listings/:listingId',
    {
      schema: {
        tags: ['discovery'],
        params: z.object({ listingId: z.uuid() }),
        querystring: z
          .object({ lat: lat.optional(), lng: lng.optional() })
          .refine((v) => (v.lat === undefined) === (v.lng === undefined), 'Send lat and lng together'),
        response: { 200: listingView },
      },
    },
    async (request) => {
      await limit(request, 'listing', 120);
      const { lat: la, lng: ln } = request.query;
      const view = await discovery.listing(
        request.params.listingId,
        la !== undefined && ln !== undefined ? { latitude: la, longitude: ln } : null,
      );
      await signal('discovery.listing_viewed', { assetId: request.params.listingId });
      return view;
    },
  );

  r.get(
    '/v1/listings/:listingId/availability',
    {
      schema: {
        tags: ['discovery'],
        params: z.object({ listingId: z.uuid() }),
        querystring: z.object({
          start: z.iso.datetime({ offset: true }),
          end: z.iso.datetime({ offset: true }),
          mode: z.enum(['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION']).optional(),
        }),
        response: {
          200: z.discriminatedUnion('available', [
            z.object({ available: z.literal(true) }),
            z.object({
              available: z.literal(false),
              reason: z.enum([
                'CLOSED',
                'BLOCKED',
                'RESERVED',
                'NO_UNITS',
                'INVALID_WINDOW',
                'LEAD_TIME',
                'DURATION',
              ]),
            }),
          ]),
        },
      },
    },
    async (request) => {
      await limit(request, 'listing', 120);
      const { start, end, mode } = request.query;
      return discovery.checkWindow(request.params.listingId, new Date(start), new Date(end), mode);
    },
  );

  r.get(
    '/v1/places/autocomplete',
    {
      schema: {
        tags: ['discovery'],
        querystring: z.object({ q: z.string().trim().min(2).max(80) }),
        response: {
          200: z.array(z.object({ placeId: z.string(), primaryText: z.string(), secondaryText: z.string() })),
        },
      },
    },
    async (request) => {
      await limit(request, 'places', 120);
      return geocoder.autocomplete(request.query.q);
    },
  );

  r.get(
    '/v1/places/area',
    {
      schema: {
        tags: ['discovery'],
        querystring: z.object({ lat, lng }),
        response: { 200: z.object({ areaLabel: z.string().nullable() }) },
      },
    },
    async (request) => {
      await limit(request, 'places', 120);
      // Only a ~1 km point leaves the platform (D-174): enough to name the locality, never the spot.
      const p = coarsePoint(request.query.lat, request.query.lng);
      return { areaLabel: await geocoder.areaAt(p.latitude, p.longitude) };
    },
  );

  r.get(
    '/v1/places/:placeId',
    {
      schema: {
        tags: ['discovery'],
        params: z.object({ placeId: z.string().min(1).max(200) }),
        response: {
          200: z.object({
            placeId: z.string(),
            name: z.string(),
            latitude: z.number(),
            longitude: z.number(),
          }),
        },
      },
    },
    async (request) => {
      await limit(request, 'places', 120);
      const place = await geocoder.details(request.params.placeId);
      if (!place) throw errors.notFound('Place not found');
      return place;
    },
  );
};
