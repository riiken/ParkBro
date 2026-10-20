import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, requirePermission, requireUser } from '../../../platform/auth/authentication.ts';
import { pageQuery } from '../../../platform/http/pagination.ts';
import { CONTACT_DETAILS_MESSAGE, findContactDetails } from '../../../platform/text/contact-details.ts';
import { MAX_RULES_PER_ASSET } from '../../availability/index.ts';
import { requireHostAccess, type HostService } from '../../identity/index.ts';
import { BOOKING_MODES, PRICING_UNITS } from '../../pricing/index.ts';
import type { AssetService } from '../application/asset-service.ts';
import { MAX_UNITS_PER_ASSET } from '../application/asset-service.ts';
import { ASSET_STATUSES } from '../domain/state-machine.ts';
import { ACCEPTED_UPLOAD_TYPES, imageErrors } from '../infrastructure/images.ts';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const publicText = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => findContactDetails(v) === null, CONTACT_DETAILS_MESSAGE);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const assetIdParams = z.object({ assetId: z.uuid() });

const parkingDetailsBody = z.object({
  covered: z.boolean(),
  level: z.enum(['BASEMENT', 'STILT', 'GROUND', 'OPEN_LOT', 'MULTI_LEVEL']),
  maxVehicleClass: z.enum(['HATCHBACK', 'SEDAN', 'SUV', 'MUV']),
  heightCm: z.number().int().min(150).max(500).nullable().default(null),
  lengthCm: z.number().int().min(300).max(800).nullable().default(null),
  security: z
    .array(z.enum(['CCTV', 'GUARD', 'GATED']))
    .max(3)
    .default([]),
  lighting: z.boolean().default(false),
  evReadySocket: z.boolean().default(false),
  tandem: z.boolean().default(false),
});
const chargerDetailsBody = z.object({
  connectors: z
    .array(z.enum(['TYPE2', 'CCS2', 'BHARAT_AC001', 'BHARAT_DC001', 'IEC_15A', 'GBT']))
    .min(1)
    .max(6),
  currentType: z.enum(['AC', 'DC']),
  powerKw: z.number().positive().max(400).multipleOf(0.1),
  cableProvided: z.boolean(),
  connectionType: z.enum(['DOMESTIC', 'EV_METERED', 'COMMERCIAL']),
});
const rateBody = z
  .object({
    mode: z.enum(BOOKING_MODES),
    unit: z.enum(PRICING_UNITS),
    pricePaise: z.number().int().min(100).max(10_000_000),
    overnightStart: time.nullable().default(null),
    overnightEnd: time.nullable().default(null),
  })
  .refine(
    (r) => (r.mode === 'OVERNIGHT') === (r.overnightStart !== null && r.overnightEnd !== null),
    'Overnight pricing needs a start and end time (and only overnight pricing has them)',
  );
const ruleBody = z
  .object({
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startLocal: time,
    endLocal: time,
    validFrom: date.optional(),
    validTo: date.nullable().optional(),
  })
  .refine(
    (r) => !r.validTo || !r.validFrom || r.validTo >= r.validFrom,
    'validTo must be on or after validFrom',
  );

const assetViewSchema = z.object({
  id: z.uuid(),
  propertyId: z.uuid(),
  type: z.enum(['PARKING', 'EV_CHARGING']),
  status: z.enum(ASSET_STATUSES),
  needsReview: z.boolean(),
  statusReason: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  rulesText: z.string(),
  accessInstructions: z.string().nullable(),
  approvalRequired: z.boolean(),
  bufferMinutes: z.number().int(),
  minMinutes: z.number().int(),
  maxMinutes: z.number().int(),
  leadMinutes: z.number().int(),
  cancellationPolicy: z.enum(['FLEXIBLE', 'MODERATE', 'STRICT']),
  version: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
  parkingDetails: parkingDetailsBody.nullable(),
  chargerDetails: chargerDetailsBody.nullable(),
  units: z.array(z.object({ id: z.uuid(), label: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']) })),
  media: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['SLOT', 'ENTRANCE', 'CHARGER', 'OTHER']),
      moderationStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
      width: z.number().int(),
      height: z.number().int(),
      url: z.string(),
      createdAt: z.date(),
    }),
  ),
  rates: z.array(
    z.object({
      mode: z.enum(BOOKING_MODES),
      unit: z.enum(PRICING_UNITS),
      pricePaise: z.number().int(),
      overnightStart: z.string().nullable().optional(),
      overnightEnd: z.string().nullable().optional(),
    }),
  ),
  availabilityRules: z.array(
    z.object({
      id: z.uuid(),
      weekdays: z.array(z.number().int()),
      startLocal: z.string(),
      endLocal: z.string(),
      validFrom: z.string().optional(),
      validTo: z.string().nullable().optional(),
    }),
  ),
  attestations: z.record(
    z.string(),
    z.object({
      status: z.string().nullable(),
      statement: z.object({ version: z.string(), text: z.string() }),
    }),
  ),
  checklist: z.object({ ready: z.boolean(), missing: z.array(z.string()) }),
});

const adminAssetSchema = assetViewSchema.omit({ accessInstructions: true, media: true }).extend({
  hostAccountId: z.uuid(),
  media: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['SLOT', 'ENTRANCE', 'CHARGER', 'OTHER']),
      moderationStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
      width: z.number().int(),
      height: z.number().int(),
      url: z.string(),
      duplicateSuspected: z.boolean(),
      captureDistanceM: z.number().int().nullable(),
      createdAt: z.date(),
    }),
  ),
});

export const assetHostRoutes: FastifyPluginAsync<{ assets: AssetService; hosts: HostService }> = async (
  app,
  { assets, hosts },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const host = (request: Parameters<typeof actorOf>[0], forWrite = true) =>
    requireHostAccess(hosts, request, { forWrite });

  // Raw image bodies for photo uploads only (encapsulated in this plugin).
  app.addContentTypeParser(
    [...ACCEPTED_UPLOAD_TYPES],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  r.post(
    '/v1/host/assets',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        body: z.object({
          propertyId: z.uuid(),
          type: z.enum(['PARKING', 'EV_CHARGING']),
          title: publicText(80, 5),
          description: publicText(1000).default(''),
          rulesText: publicText(1000).default(''),
          // Private (revealed only after a confirmed booking), so contact details are allowed here.
          accessInstructions: z.string().trim().max(1000).nullable().default(null),
        }),
        response: { 201: assetViewSchema },
      },
    },
    async (request, reply) =>
      reply.status(201).send(await assets.createAsset(await host(request), request.body, request.id)),
  );

  r.get(
    '/v1/host/assets',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              propertyId: z.uuid(),
              type: z.enum(['PARKING', 'EV_CHARGING']),
              status: z.enum(ASSET_STATUSES),
              title: z.string(),
              needsReview: z.boolean(),
              ready: z.boolean(),
              missing: z.array(z.string()),
            }),
          ),
        },
      },
    },
    async (request) => assets.listHostAssets(await host(request, false)),
  );

  r.get(
    '/v1/host/assets/:assetId',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: assetIdParams, response: { 200: assetViewSchema } },
    },
    async (request) => assets.getHostAsset(await host(request, false), request.params.assetId),
  );

  r.patch(
    '/v1/host/assets/:assetId',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: z
          .object({
            version: z.number().int(),
            title: publicText(80, 5).optional(),
            description: publicText(1000).optional(),
            rulesText: publicText(1000).optional(),
            accessInstructions: z.string().trim().max(1000).nullable().optional(),
            approvalRequired: z.boolean().optional(),
            bufferMinutes: z.number().int().min(0).max(240).optional(),
            minMinutes: z.number().int().min(15).max(43_200).optional(),
            maxMinutes: z.number().int().min(15).max(44_640).optional(),
            leadMinutes: z.number().int().min(0).max(10_080).optional(),
            cancellationPolicy: z.enum(['FLEXIBLE', 'MODERATE', 'STRICT']).optional(),
          })
          .strict(),
        response: { 200: assetViewSchema },
      },
    },
    async (request) =>
      assets.updateAsset(await host(request), request.params.assetId, request.body, request.id),
  );

  r.put(
    '/v1/host/assets/:assetId/parking-details',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: parkingDetailsBody,
        response: { 200: assetViewSchema },
      },
    },
    async (request) => assets.setParkingDetails(await host(request), request.params.assetId, request.body),
  );

  r.put(
    '/v1/host/assets/:assetId/charger-details',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: chargerDetailsBody,
        response: { 200: assetViewSchema },
      },
    },
    async (request) => assets.setChargerDetails(await host(request), request.params.assetId, request.body),
  );

  r.put(
    '/v1/host/assets/:assetId/units',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: z.object({
          labels: z
            .array(publicText(30, 1))
            .min(1)
            .max(MAX_UNITS_PER_ASSET)
            .refine((l) => new Set(l).size === l.length, 'Space labels must be unique'),
        }),
        response: { 200: assetViewSchema },
      },
    },
    async (request) => assets.setUnits(await host(request), request.params.assetId, request.body.labels),
  );

  r.put(
    '/v1/host/assets/:assetId/rates',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: z.object({
          rates: z
            .array(rateBody)
            .max(BOOKING_MODES.length)
            .refine(
              (rates) => new Set(rates.map((r) => r.mode)).size === rates.length,
              'One price per booking type',
            ),
        }),
        response: { 200: assetViewSchema },
      },
    },
    async (request) => assets.setRates(await host(request), request.params.assetId, request.body.rates),
  );

  r.put(
    '/v1/host/assets/:assetId/availability-rules',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: z.object({ rules: z.array(ruleBody).max(MAX_RULES_PER_ASSET) }),
        response: { 200: assetViewSchema },
      },
    },
    async (request) =>
      assets.setAvailabilityRules(await host(request), request.params.assetId, request.body.rules),
  );

  r.post(
    '/v1/host/assets/:assetId/attestations',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: z.object({ kind: z.enum(['RIGHT_TO_RENT', 'CHARGER_SAFETY']), accepted: z.literal(true) }),
        response: { 200: assetViewSchema },
      },
    },
    async (request) =>
      assets.attest(await host(request), request.params.assetId, request.body.kind, request.id),
  );

  const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v).getTime());

  r.post(
    '/v1/host/assets/:assetId/availability-exceptions',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        body: z.object({
          kind: z.enum(['BLOCK', 'OPEN']),
          start: instant,
          end: instant,
          unitId: z.uuid().nullable().default(null),
          reason: z.string().trim().max(200).nullable().default(null),
        }),
        response: { 201: z.object({ id: z.uuid() }) },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await assets.addException(await host(request), request.params.assetId, request.body, request.id),
        ),
  );

  r.delete(
    '/v1/host/assets/:assetId/availability-exceptions/:exceptionId',
    {
      preHandler: requireUser,
      schema: { tags: ['host'], params: z.object({ assetId: z.uuid(), exceptionId: z.uuid() }) },
    },
    async (request, reply) => {
      await assets.removeException(
        await host(request),
        request.params.assetId,
        request.params.exceptionId,
        request.id,
      );
      return reply.status(204).send();
    },
  );

  r.get(
    '/v1/host/assets/:assetId/calendar',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        querystring: z.object({ from: instant, to: instant }),
        response: {
          200: z.object({
            timezone: z.string(),
            units: z.array(
              z.object({
                id: z.uuid(),
                label: z.string(),
                free: z.array(z.object({ start: z.date(), end: z.date() })),
              }),
            ),
            exceptions: z.array(
              z.object({
                id: z.uuid(),
                unitId: z.uuid().nullable(),
                kind: z.enum(['BLOCK', 'OPEN']),
                start: z.date(),
                end: z.date(),
                reason: z.string().nullable(),
              }),
            ),
            reservations: z.array(z.object({ unitId: z.uuid(), start: z.date(), end: z.date() })),
          }),
        },
      },
    },
    async (request) =>
      assets.calendar(
        await host(request, false),
        request.params.assetId,
        request.query.from,
        request.query.to,
      ),
  );

  r.post(
    '/v1/host/assets/:assetId/media',
    {
      preHandler: requireUser,
      bodyLimit: MAX_UPLOAD_BYTES,
      schema: {
        tags: ['host'],
        params: assetIdParams,
        querystring: z
          .object({
            kind: z.enum(['SLOT', 'ENTRANCE', 'CHARGER', 'OTHER']),
            // Optional device location at capture time (V-GEO soft check).
            lat: z.coerce.number().min(-90).max(90).optional(),
            lng: z.coerce.number().min(-180).max(180).optional(),
          })
          .refine((q) => (q.lat === undefined) === (q.lng === undefined), 'Send lat and lng together'),
        response: { 201: assetViewSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) throw imageErrors.unsupported();
      const { kind, lat, lng } = request.query;
      const capturedAt =
        lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng } : undefined;
      return reply
        .status(201)
        .send(
          await assets.addPhoto(
            await host(request),
            request.params.assetId,
            { kind, body, capturedAt },
            request.id,
          ),
        );
    },
  );

  r.delete(
    '/v1/host/assets/:assetId/media/:mediaId',
    {
      preHandler: requireUser,
      schema: {
        tags: ['host'],
        params: z.object({ assetId: z.uuid(), mediaId: z.uuid() }),
        response: { 200: assetViewSchema },
      },
    },
    async (request) =>
      assets.removePhoto(await host(request), request.params.assetId, request.params.mediaId, request.id),
  );

  for (const [path, action] of [
    ['submit', 'SUBMIT'],
    ['pause', 'PAUSE'],
    ['republish', 'REPUBLISH'],
    ['archive', 'ARCHIVE'],
  ] as const) {
    r.post(
      `/v1/host/assets/:assetId/${path}`,
      {
        preHandler: requireUser,
        schema: { tags: ['host'], params: assetIdParams, response: { 200: assetViewSchema } },
      },
      async (request) => assets.hostAction(await host(request), request.params.assetId, action, request.id),
    );
  }

  // Photos: public for published listings (non-entrance, approved), otherwise owner only (§11, L-5).
  r.get(
    '/v1/media/:mediaId',
    { schema: { tags: ['media'], params: z.object({ mediaId: z.uuid() }) } },
    async (request, reply) => {
      const access = request.actor.kind === 'user' ? await hosts.hostAccessFor(request.actor.userId) : null;
      const media = await assets.readMedia(request.params.mediaId, {
        hostAccountId: access?.hostAccountId ?? null,
        isAdmin: false,
      });
      return reply
        .type('image/webp')
        .header('cache-control', media.cacheable ? 'public, max-age=3600' : 'private, no-store')
        .header('content-disposition', 'inline')
        .send(media.data);
    },
  );
};

/** Listing review (AJ-1) and enforcement. API only until the admin console (Phase 20). Mounted under /admin. */
export const assetAdminRoutes: FastifyPluginAsync<{ assets: AssetService }> = async (app, { assets }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guard = requirePermission('TRUST_SAFETY');

  r.get(
    '/v1/assets',
    {
      preHandler: requirePermission('TRUST_SAFETY', 'SUPPORT'),
      schema: {
        tags: ['admin'],
        querystring: z.object({
          q: z.string().trim().max(80).optional(),
          status: z.enum(ASSET_STATUSES).optional(),
          type: z.enum(['PARKING', 'EV_CHARGING']).optional(),
          hostAccountId: z.uuid().optional(),
          ...pageQuery,
        }),
      },
    },
    async (request) => assets.adminList(request.query),
  );

  r.get(
    '/review/assets',
    { preHandler: guard, schema: { tags: ['admin'], response: { 200: z.array(adminAssetSchema) } } },
    async () => assets.reviewQueue(),
  );
  r.get(
    '/assets/:assetId',
    {
      preHandler: guard,
      schema: { tags: ['admin'], params: assetIdParams, response: { 200: adminAssetSchema } },
    },
    async (request) => assets.adminAsset(request.params.assetId),
  );

  for (const [path, action, reasonRequired] of [
    ['approve', 'APPROVE', false],
    ['reject', 'REJECT', true],
    ['suspend', 'SUSPEND', true],
    ['reinstate', 'REINSTATE', true],
  ] as const) {
    r.post(
      `/assets/:assetId/${path}`,
      {
        preHandler: guard,
        schema: {
          tags: ['admin'],
          params: assetIdParams,
          body: z.object({
            reason: reasonRequired
              ? z.string().trim().min(3).max(500)
              : z.string().trim().max(500).optional(),
          }),
          response: { 200: adminAssetSchema },
        },
      },
      async (request) =>
        assets.adminAction(
          { userId: actorOf(request).userId },
          request.params.assetId,
          action,
          request.body.reason,
          request.id,
        ),
    );
  }

  r.get(
    '/media/:mediaId',
    { preHandler: guard, schema: { tags: ['admin'], params: z.object({ mediaId: z.uuid() }) } },
    async (request, reply) => {
      const media = await assets.adminReadMedia(request.params.mediaId);
      return reply.type('image/webp').header('cache-control', 'private, no-store').send(media.data);
    },
  );
};
