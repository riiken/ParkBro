import { sql, type Kysely, type Transaction } from 'kysely';
import type { AnyKyselyExecutor, AuditLog } from '../../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../../platform/crypto/field-cipher.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { ObjectStorage } from '../../../platform/providers/object-storage.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import {
  freeTime,
  type AvailabilityModule,
  type AvailabilityRuleInput,
  type ReservationSource,
} from '../../availability/index.ts';
import type { HostAccess } from '../../identity/index.ts';
import type { PricingModule, RateInput } from '../../pricing/index.ts';
import { UNITS_FOR_MODE } from '../../pricing/index.ts';
import {
  haversineMeters,
  participationHaltsListings,
  type PropertiesModule,
} from '../../properties/index.ts';
import { ATTESTATIONS, type AttestationKind, type TrustModule } from '../../trust/index.ts';
import { publishChecklist, type ChecklistItem } from '../domain/checklist.ts';
import { transition, type AssetAction, type AssetStatus } from '../domain/state-machine.ts';
import { processListingPhoto } from '../infrastructure/images.ts';
import type { AssetsDb } from '../infrastructure/tables.ts';

const ACCESS_CONTEXT = 'assets.access_instructions';
export const MAX_PHOTOS_PER_ASSET = 10;
export const MAX_UNITS_PER_ASSET = 200;
const DUPLICATE_HAMMING_THRESHOLD = 6;

export type AssetType = 'PARKING' | 'EV_CHARGING';
export type MediaKind = 'SLOT' | 'ENTRANCE' | 'CHARGER' | 'OTHER';
type Host = HostAccess & { userId: string };
type Actor =
  | { kind: 'HOST'; userId: string }
  | { kind: 'PLATFORM_ADMIN'; userId: string }
  | { kind: 'SYSTEM'; userId: null };

export const assetErrors = {
  hasUpcomingBookings: () =>
    new DomainError({
      code: 'asset.has_upcoming_bookings',
      status: 409,
      title: 'This listing still has upcoming bookings',
      detail: 'Pause it to stop new bookings. You can archive it once the last booking ends.',
    }),
  propertyNotAvailable: () =>
    new DomainError({
      code: 'asset.property_unavailable',
      status: 400,
      title: "You can't list at this property",
      detail: 'Choose one of your properties, or a society that has approved you as a host.',
    }),
  transitionNotAllowed: (from: string, action: string) =>
    new DomainError({
      code: 'asset.transition_not_allowed',
      status: 409,
      title: 'That action is not available right now',
      detail: `A listing that is ${from.toLowerCase().replace('_', ' ')} can't be ${action.toLowerCase()}ed.`,
    }),
  notReady: (missing: ChecklistItem[]) =>
    new DomainError({
      code: 'asset.not_ready',
      status: 422,
      title: 'Your listing is not ready to publish',
      detail: `Still needed: ${missing.join(', ')}`,
    }),
  wrongType: (detail: string) =>
    new DomainError({
      code: 'asset.wrong_type',
      status: 400,
      title: 'Not available for this listing type',
      detail,
    }),
  photoLimit: () =>
    new DomainError({
      code: 'media.limit_reached',
      status: 409,
      title: `A listing can have at most ${MAX_PHOTOS_PER_ASSET} photos`,
    }),
  archived: () => new DomainError({ code: 'asset.archived', status: 409, title: 'This listing is archived' }),
  blockConflictsBooking: () =>
    new DomainError({
      code: 'availability.block_conflicts_booking',
      status: 409,
      title: 'There is a booking in that time',
      detail: 'Cancel the booking first if you need the space back (the customer is refunded in full).',
    }),
  invalidWindow: (detail: string) =>
    new DomainError({
      code: 'availability.invalid_window',
      status: 400,
      title: 'Invalid time window',
      detail,
    }),
  unknownUnit: () =>
    new DomainError({
      code: 'availability.unknown_unit',
      status: 400,
      title: "That space isn't part of this listing",
    }),
};

const MAX_EXCEPTION_DAYS = 366;
const MAX_CALENDAR_DAYS = 62;

export function createAssetService(deps: {
  db: Kysely<AssetsDb>;
  cipher: FieldCipher;
  audit: AuditLog;
  events: DomainEventBus;
  storage: ObjectStorage;
  rateLimiter: RateLimiter;
  properties: PropertiesModule;
  pricing: PricingModule;
  availability: AvailabilityModule;
  trust: TrustModule;
  reservations: ReservationSource;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const { db, cipher, audit, storage } = deps;

  // ------------------------------------------------------------------ helpers

  async function assetType(code: string) {
    return db.selectFrom('assets.asset_types').selectAll().where('code', '=', code).executeTakeFirstOrThrow();
  }

  /** Loads and row-locks an asset owned by the host; other hosts' assets are "not found". */
  async function lockOwned(trx: Transaction<AssetsDb>, host: Host, assetId: string) {
    const asset = await trx
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', assetId)
      .where('host_account_id', '=', host.hostAccountId)
      .forUpdate()
      .executeTakeFirst();
    if (!asset) throw errors.notFound();
    if (asset.status === 'ARCHIVED') throw assetErrors.archived();
    return asset;
  }

  async function lockAny(trx: Transaction<AssetsDb>, assetId: string) {
    const asset = await trx
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', assetId)
      .forUpdate()
      .executeTakeFirst();
    if (!asset) throw errors.notFound();
    return asset;
  }

  async function applyTransition(
    trx: Kysely<AssetsDb>,
    asset: { id: string; status: string; needs_review: boolean },
    action: AssetAction,
    actor: Actor,
    options: { reason?: string | undefined; requestId: string },
  ): Promise<AssetStatus> {
    const result = transition(asset.status as AssetStatus, action, { needsReview: asset.needs_review });
    if (!result) throw assetErrors.transitionNotAllowed(asset.status, action);
    await trx
      .updateTable('assets.assets')
      .set({
        status: result.to,
        needs_review: result.needsReview,
        status_reason: options.reason ?? null,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', asset.id)
      .execute();
    if (result.to !== asset.status) {
      await trx
        .insertInto('assets.asset_events')
        .values({
          asset_id: asset.id,
          from_status: asset.status,
          to_status: result.to,
          actor_kind: actor.kind,
          actor_id: actor.userId,
          reason: options.reason ?? action,
          request_id: options.requestId,
        })
        .execute();
    }
    return result.to;
  }

  async function materialChange(
    trx: Kysely<AssetsDb>,
    asset: { id: string; status: string; needs_review: boolean },
    actor: Actor,
    reason: string,
    requestId: string,
  ) {
    if (asset.status === 'ARCHIVED') return;
    await applyTransition(trx, asset, 'MATERIAL_CHANGE', actor, { reason, requestId });
  }

  async function touch(trx: Kysely<AssetsDb>, assetId: string) {
    await trx
      .updateTable('assets.assets')
      .set({ version: sql<number>`version + 1` })
      .where('id', '=', assetId)
      .execute();
  }

  // ------------------------------------------------------------------ host: create and read

  async function createAsset(
    host: Host,
    input: {
      propertyId: string;
      type: AssetType;
      title: string;
      description: string;
      rulesText: string;
      accessInstructions: string | null;
    },
    requestId: string,
  ) {
    const listing = await deps.properties.listingContext(input.propertyId, host.hostAccountId);
    if (!listing?.canDraft) throw assetErrors.propertyNotAvailable();
    const id = uuidv7();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('assets.assets')
        .values({
          id,
          property_id: input.propertyId,
          host_account_id: host.hostAccountId,
          asset_type: input.type,
          title: input.title,
          description: input.description,
          rules_text: input.rulesText,
          access_instructions_enc: input.accessInstructions
            ? cipher.encrypt(input.accessInstructions, ACCESS_CONTEXT)
            : null,
        })
        .execute();
      // Every asset starts with one unit; hosts with interchangeable spaces add more (D-012).
      await trx
        .insertInto('assets.asset_units')
        .values({ id: uuidv7(), asset_id: id, label: 'Space 1' })
        .execute();
      await trx
        .insertInto('assets.asset_events')
        .values({
          asset_id: id,
          from_status: null,
          to_status: 'DRAFT',
          actor_kind: 'HOST',
          actor_id: host.userId,
          reason: 'created',
          request_id: requestId,
        })
        .execute();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'asset.created',
          entityKind: 'asset',
          entityId: id,
          metadata: { type: input.type },
          requestId,
        },
        trx,
      );
    });
    return getHostAsset(host, id);
  }

  async function snapshot(assetId: string) {
    const asset = await db
      .selectFrom('assets.assets')
      .selectAll()
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!asset) throw errors.notFound();
    const [type, parking, charger, units, media, rates, rules, attestations] = await Promise.all([
      assetType(asset.asset_type),
      db.selectFrom('assets.parking_details').selectAll().where('asset_id', '=', assetId).executeTakeFirst(),
      db.selectFrom('assets.charger_details').selectAll().where('asset_id', '=', assetId).executeTakeFirst(),
      db
        .selectFrom('assets.asset_units')
        .select(['id', 'label', 'status'])
        .where('asset_id', '=', assetId)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('assets.asset_media')
        .select([
          'id',
          'kind',
          'moderation_status',
          'width',
          'height',
          'duplicate_suspected',
          'capture_distance_m',
          'created_at',
        ])
        .where('asset_id', '=', assetId)
        .where('removed_at', 'is', null)
        .orderBy('position')
        .orderBy('created_at')
        .execute(),
      deps.pricing.currentRates(assetId),
      deps.availability.listRules(assetId),
      deps.trust.latestStatuses('ASSET', assetId),
    ]);
    return { asset, type, parking, charger, units, media, rates, rules, attestations };
  }

  function checklistFor(
    s: Awaited<ReturnType<typeof snapshot>>,
    listing: { canPublish: boolean } | null,
    hostActive: boolean,
  ) {
    return publishChecklist({
      assetType: s.asset.asset_type as AssetType,
      requiredMediaKinds: s.type.required_media_kinds,
      requiredAttestations: s.type.required_attestations,
      hasParkingDetails: s.parking !== undefined,
      hasChargerDetails: s.charger !== undefined,
      activeUnits: s.units.filter((u) => u.status === 'ACTIVE').length,
      mediaKinds: s.media.filter((m) => m.moderation_status !== 'REJECTED').map((m) => m.kind),
      rateModes: s.rates.map((r) => r.mode),
      availabilityRules: s.rules.length,
      attestationStatuses: s.attestations,
      listing,
      hostActive,
    });
  }

  function view(
    s: Awaited<ReturnType<typeof snapshot>>,
    checklist: { ready: boolean; missing: ChecklistItem[] },
  ) {
    const a = s.asset;
    return {
      id: a.id,
      propertyId: a.property_id,
      type: a.asset_type as AssetType,
      status: a.status as AssetStatus,
      needsReview: a.needs_review,
      statusReason: a.status_reason,
      title: a.title,
      description: a.description,
      rulesText: a.rules_text,
      accessInstructions: a.access_instructions_enc
        ? cipher.decrypt(a.access_instructions_enc, ACCESS_CONTEXT)
        : null,
      approvalRequired: a.approval_required,
      bufferMinutes: a.buffer_minutes,
      minMinutes: a.min_minutes,
      maxMinutes: a.max_minutes,
      leadMinutes: a.lead_minutes,
      cancellationPolicy: a.cancellation_policy_code as 'FLEXIBLE' | 'MODERATE' | 'STRICT',
      version: a.version,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      parkingDetails: s.parking
        ? {
            covered: s.parking.covered,
            level: s.parking.level as 'BASEMENT' | 'STILT' | 'GROUND' | 'OPEN_LOT' | 'MULTI_LEVEL',
            maxVehicleClass: s.parking.max_vehicle_class as 'HATCHBACK' | 'SEDAN' | 'SUV' | 'MUV',
            heightCm: s.parking.height_cm,
            lengthCm: s.parking.length_cm,
            security: s.parking.security as ('CCTV' | 'GUARD' | 'GATED')[],
            lighting: s.parking.lighting,
            evReadySocket: s.parking.ev_ready_socket,
            tandem: s.parking.tandem,
          }
        : null,
      chargerDetails: s.charger
        ? {
            connectors: s.charger.connectors as (
              'TYPE2' | 'CCS2' | 'BHARAT_AC001' | 'BHARAT_DC001' | 'IEC_15A' | 'GBT'
            )[],
            currentType: s.charger.current_type as 'AC' | 'DC',
            powerKw: Number(s.charger.power_kw),
            cableProvided: s.charger.cable_provided,
            connectionType: s.charger.connection_type as 'DOMESTIC' | 'EV_METERED' | 'COMMERCIAL',
          }
        : null,
      units: s.units.map((u) => ({ id: u.id, label: u.label, status: u.status as 'ACTIVE' | 'INACTIVE' })),
      media: s.media.map((m) => ({
        id: m.id,
        kind: m.kind as MediaKind,
        moderationStatus: m.moderation_status as 'PENDING' | 'APPROVED' | 'REJECTED',
        width: m.width,
        height: m.height,
        url: `/api/v1/media/${m.id}`,
        createdAt: m.created_at,
      })),
      rates: s.rates.map(({ effectiveFrom: _e, ...r }) => r),
      availabilityRules: s.rules,
      attestations: Object.fromEntries(
        s.type.required_attestations.map((k) => [
          k,
          {
            status: s.attestations[k as AttestationKind] ?? null,
            statement: ATTESTATIONS[k as AttestationKind],
          },
        ]),
      ),
      checklist,
    };
  }

  async function getHostAsset(host: Host, assetId: string) {
    const s = await snapshot(assetId);
    if (s.asset.host_account_id !== host.hostAccountId) throw errors.notFound();
    const listing = await deps.properties.listingContext(s.asset.property_id, host.hostAccountId);
    return view(s, checklistFor(s, listing, host.status === 'ACTIVE'));
  }

  async function listHostAssets(host: Host) {
    const rows = await db
      .selectFrom('assets.assets')
      .select('id')
      .where('host_account_id', '=', host.hostAccountId)
      .where('status', '<>', 'ARCHIVED')
      .orderBy('created_at', 'desc')
      .execute();
    const assets = await Promise.all(rows.map((r) => getHostAsset(host, r.id)));
    return assets.map((a) => ({
      id: a.id,
      propertyId: a.propertyId,
      type: a.type,
      status: a.status,
      title: a.title,
      needsReview: a.needsReview,
      ready: a.checklist.ready,
      missing: a.checklist.missing,
    }));
  }

  // ------------------------------------------------------------------ host: edits

  async function updateAsset(
    host: Host,
    assetId: string,
    changes: {
      version: number;
      title?: string | undefined;
      description?: string | undefined;
      rulesText?: string | undefined;
      accessInstructions?: string | null | undefined;
      approvalRequired?: boolean | undefined;
      bufferMinutes?: number | undefined;
      minMinutes?: number | undefined;
      maxMinutes?: number | undefined;
      leadMinutes?: number | undefined;
      cancellationPolicy?: 'FLEXIBLE' | 'MODERATE' | 'STRICT' | undefined;
    },
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      if (asset.version !== changes.version) throw errors.stale();
      const min = changes.minMinutes ?? asset.min_minutes;
      const max = changes.maxMinutes ?? asset.max_minutes;
      if (min > max) {
        throw new DomainError({
          code: 'request.invalid',
          status: 400,
          title: 'Invalid request',
          detail: 'Minimum duration exceeds maximum.',
        });
      }
      await trx
        .updateTable('assets.assets')
        .set({
          ...(changes.title === undefined ? {} : { title: changes.title }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.rulesText === undefined ? {} : { rules_text: changes.rulesText }),
          ...(changes.accessInstructions === undefined
            ? {}
            : {
                access_instructions_enc: changes.accessInstructions
                  ? cipher.encrypt(changes.accessInstructions, ACCESS_CONTEXT)
                  : null,
              }),
          ...(changes.approvalRequired === undefined ? {} : { approval_required: changes.approvalRequired }),
          ...(changes.bufferMinutes === undefined ? {} : { buffer_minutes: changes.bufferMinutes }),
          ...(changes.minMinutes === undefined ? {} : { min_minutes: changes.minMinutes }),
          ...(changes.maxMinutes === undefined ? {} : { max_minutes: changes.maxMinutes }),
          ...(changes.leadMinutes === undefined ? {} : { lead_minutes: changes.leadMinutes }),
          ...(changes.cancellationPolicy === undefined
            ? {}
            : { cancellation_policy_code: changes.cancellationPolicy }),
          version: sql<number>`version + 1`,
        })
        .where('id', '=', assetId)
        .execute();
      const fields = Object.keys(changes).filter((k) => k !== 'version');
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'asset.updated',
          entityKind: 'asset',
          entityId: assetId,
          metadata: { fields: fields.join(',') },
          requestId,
        },
        trx,
      );
    });
    return getHostAsset(host, assetId);
  }

  async function setParkingDetails(
    host: Host,
    assetId: string,
    d: {
      covered: boolean;
      level: string;
      maxVehicleClass: string;
      heightCm: number | null;
      lengthCm: number | null;
      security: string[];
      lighting: boolean;
      evReadySocket: boolean;
      tandem: boolean;
    },
  ) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      if (asset.asset_type === 'EV_CHARGING' && d.evReadySocket) {
        throw assetErrors.wrongType(
          'An EV charging listing already offers charging; leave "EV-ready socket" off.',
        );
      }
      const row = {
        covered: d.covered,
        level: d.level,
        max_vehicle_class: d.maxVehicleClass,
        height_cm: d.heightCm,
        length_cm: d.lengthCm,
        security: [...new Set(d.security)],
        lighting: d.lighting,
        ev_ready_socket: d.evReadySocket,
        tandem: d.tandem,
      };
      await trx
        .insertInto('assets.parking_details')
        .values({ asset_id: assetId, ...row })
        .onConflict((oc) => oc.column('asset_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }))
        .execute();
      await touch(trx, assetId);
    });
    return getHostAsset(host, assetId);
  }

  async function setChargerDetails(
    host: Host,
    assetId: string,
    d: {
      connectors: string[];
      currentType: string;
      powerKw: number;
      cableProvided: boolean;
      connectionType: string;
    },
  ) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      if (asset.asset_type !== 'EV_CHARGING')
        throw assetErrors.wrongType('Charger details apply to EV charging listings only.');
      const row = {
        connectors: [...new Set(d.connectors)],
        current_type: d.currentType,
        power_kw: d.powerKw,
        cable_provided: d.cableProvided,
        connection_type: d.connectionType,
      };
      await trx
        .insertInto('assets.charger_details')
        .values({ asset_id: assetId, ...row })
        .onConflict((oc) => oc.column('asset_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }))
        .execute();
      await touch(trx, assetId);
    });
    return getHostAsset(host, assetId);
  }

  /** Replaces the set of active unit labels. Removed units are deactivated, never deleted (bookings reference them). */
  async function setUnits(host: Host, assetId: string, labels: string[]) {
    await db.transaction().execute(async (trx) => {
      await lockOwned(trx, host, assetId);
      const wanted = new Set(labels);
      const existing = await trx
        .selectFrom('assets.asset_units')
        .select(['id', 'label', 'status'])
        .where('asset_id', '=', assetId)
        .execute();
      for (const unit of existing) {
        const status = wanted.has(unit.label) ? 'ACTIVE' : 'INACTIVE';
        if (unit.status !== status)
          await trx.updateTable('assets.asset_units').set({ status }).where('id', '=', unit.id).execute();
      }
      const known = new Set(existing.map((u) => u.label));
      const fresh = labels.filter((l) => !known.has(l));
      if (fresh.length > 0) {
        await trx
          .insertInto('assets.asset_units')
          .values(fresh.map((label) => ({ id: uuidv7(), asset_id: assetId, label })))
          .execute();
      }
      await touch(trx, assetId);
    });
    return getHostAsset(host, assetId);
  }

  async function setRates(host: Host, assetId: string, rates: RateInput[]) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      const type = await assetType(asset.asset_type);
      for (const rate of rates) {
        if (!type.allowed_modes.includes(rate.mode)) {
          throw assetErrors.wrongType(
            `${rate.mode} pricing is not available for ${asset.asset_type} listings.`,
          );
        }
        if (!UNITS_FOR_MODE[rate.mode].includes(rate.unit)) {
          throw assetErrors.wrongType(
            `${rate.mode} must be priced ${UNITS_FOR_MODE[rate.mode].join(' or ')}.`,
          );
        }
      }
      // Existing bookings keep their snapshot price (BR-17); this only affects future quotes.
      await deps.pricing.replaceRates(assetId, rates, trx);
      await touch(trx, assetId);
    });
    return getHostAsset(host, assetId);
  }

  async function setAvailabilityRules(host: Host, assetId: string, rules: AvailabilityRuleInput[]) {
    await db.transaction().execute(async (trx) => {
      await lockOwned(trx, host, assetId);
      await deps.availability.replaceRules(assetId, rules, trx);
      await touch(trx, assetId);
    });
    return getHostAsset(host, assetId);
  }

  async function attest(host: Host, assetId: string, kind: AttestationKind, requestId: string) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      const type = await assetType(asset.asset_type);
      if (!type.required_attestations.includes(kind))
        throw assetErrors.wrongType(`${kind} doesn't apply to this listing.`);
      await deps.trust.attest({ subjectKind: 'ASSET', subjectId: assetId, kind, actorId: host.userId }, trx);
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'asset.attested',
          entityKind: 'asset',
          entityId: assetId,
          metadata: { kind, statement: ATTESTATIONS[kind].version },
          requestId,
        },
        trx,
      );
      await touch(trx, assetId);
    });
    return getHostAsset(host, assetId);
  }

  // ------------------------------------------------------------------ availability: blocks, openings, calendar

  function validateWindow(start: number, end: number, maxDays: number, mustBeFuture: boolean) {
    if (!(end > start)) throw assetErrors.invalidWindow('The end must be after the start.');
    if (start % 60_000 !== 0 || end % 60_000 !== 0) throw assetErrors.invalidWindow('Use whole minutes.');
    if (end - start > maxDays * 86_400_000)
      throw assetErrors.invalidWindow(`At most ${maxDays} days at a time.`);
    if (mustBeFuture && end <= now()) throw assetErrors.invalidWindow('That time is already in the past.');
  }

  /**
   * Host blocks time (or adds an extra opening). A BLOCK may never overlap a holding booking (BR-04): the asset row
   * is locked FOR UPDATE, and the booking transaction takes the same row FOR SHARE (lock order property → asset →
   * bookings, database-design §6.4), so a block and a booking can't both commit for the same time.
   */
  async function addException(
    host: Host,
    assetId: string,
    input: {
      kind: 'BLOCK' | 'OPEN';
      start: number;
      end: number;
      unitId: string | null;
      reason: string | null;
    },
    requestId: string,
  ) {
    validateWindow(input.start, input.end, MAX_EXCEPTION_DAYS, true);
    const id = await db.transaction().execute(async (trx) => {
      await lockOwned(trx, host, assetId);
      const units = await trx
        .selectFrom('assets.asset_units')
        .select('id')
        .where('asset_id', '=', assetId)
        .where('status', '=', 'ACTIVE')
        .orderBy('label')
        .execute();
      if (input.unitId !== null && !units.some((u) => u.id === input.unitId)) throw assetErrors.unknownUnit();
      if (input.kind === 'BLOCK') {
        const affected = input.unitId ? [input.unitId] : units.map((u) => u.id);
        const clashes = await deps.reservations.holdingReservations(affected, input.start, input.end, trx);
        if (clashes.some((r) => r.start < input.end && r.blockedUntil > input.start))
          throw assetErrors.blockConflictsBooking();
      }
      const exceptionId = await deps.availability.addException(
        { assetId, ...input, createdBy: host.userId },
        trx,
      );
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: input.kind === 'BLOCK' ? 'availability.blocked' : 'availability.opened',
          entityKind: 'asset',
          entityId: assetId,
          metadata: { exceptionId, unitScoped: input.unitId !== null },
          requestId,
        },
        trx,
      );
      await touch(trx, assetId);
      return exceptionId;
    });
    return { id };
  }

  async function removeException(host: Host, assetId: string, exceptionId: string, requestId: string) {
    await db.transaction().execute(async (trx) => {
      await lockOwned(trx, host, assetId);
      if (!(await deps.availability.removeException(assetId, exceptionId, trx))) throw errors.notFound();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'availability.exception_removed',
          entityKind: 'asset',
          entityId: assetId,
          metadata: { exceptionId },
          requestId,
        },
        trx,
      );
      await touch(trx, assetId);
    });
  }

  /** Host calendar (H-05): free time per space plus blocks, openings and reservations for [from, to). */
  async function calendar(host: Host, assetId: string, from: number, to: number) {
    validateWindow(from, to, MAX_CALENDAR_DAYS, false);
    const asset = await db
      .selectFrom('assets.assets')
      .select(['id', 'property_id', 'buffer_minutes'])
      .where('id', '=', assetId)
      .where('host_account_id', '=', host.hostAccountId)
      .executeTakeFirst();
    if (!asset) throw errors.notFound();
    const [timezone, units, rules, exceptions] = await Promise.all([
      deps.properties.timezoneOf(asset.property_id),
      db
        .selectFrom('assets.asset_units')
        .select(['id', 'label'])
        .where('asset_id', '=', assetId)
        .where('status', '=', 'ACTIVE')
        .orderBy('label')
        .execute(),
      deps.availability.listRules(assetId),
      deps.availability.listExceptions(assetId, { from, to }),
    ]);
    const reservations = await deps.reservations.holdingReservations(
      units.map((u) => u.id),
      from,
      to,
    );
    const tz = timezone ?? 'Asia/Kolkata';
    const free = freeTime(
      {
        timezone: tz,
        bufferMinutes: asset.buffer_minutes,
        unitIds: units.map((u) => u.id),
        rules: rules.map((r) => ({
          weekdays: r.weekdays,
          startLocal: r.startLocal,
          endLocal: r.endLocal,
          validFrom: r.validFrom ?? '1970-01-01',
          validTo: r.validTo ?? null,
        })),
        exceptions,
        reservations,
      },
      from,
      to,
    );
    const iso = (ms: number) => new Date(ms);
    return {
      timezone: tz,
      units: units.map((u) => ({
        id: u.id,
        label: u.label,
        free: (free.get(u.id) ?? []).map((i) => ({ start: iso(i.start), end: iso(i.end) })),
      })),
      exceptions: exceptions.map((e) => ({
        id: e.id,
        unitId: e.unitId,
        kind: e.kind,
        start: iso(e.start),
        end: iso(e.end),
        reason: e.reason,
      })),
      reservations: reservations.map((r) => ({
        unitId: r.unitId,
        start: iso(r.start),
        end: iso(r.blockedUntil),
      })),
    };
  }

  // ------------------------------------------------------------------ booking support (Phase 12)

  /**
   * Booking transaction step 2: the asset row FOR SHARE (concurrent bookings proceed together; a host block, which
   * takes FOR UPDATE, waits; BR-04 / D-086), plus everything the booking engine needs about the asset.
   */
  async function bookingContext(assetId: string, executor?: unknown) {
    const q = ((executor as Kysely<AssetsDb> | undefined) ?? db)
      .selectFrom('assets.assets as a')
      .innerJoin('assets.parking_details as pd', 'pd.asset_id', 'a.id')
      .leftJoin('assets.charger_details as cd', 'cd.asset_id', 'a.id')
      .select([
        'a.id',
        'a.status',
        'a.title',
        'a.asset_type',
        'a.host_account_id',
        'a.property_id',
        'a.buffer_minutes',
        'a.approval_required',
        'a.min_minutes',
        'a.max_minutes',
        'a.lead_minutes',
        'a.cancellation_policy_code',
        'pd.max_vehicle_class',
        'cd.connectors',
      ])
      .where('a.id', '=', assetId);
    const row = executor ? await q.forShare('a').executeTakeFirst() : await q.executeTakeFirst();
    if (!row) return null;
    const units = await ((executor as Kysely<AssetsDb> | undefined) ?? db)
      .selectFrom('assets.asset_units')
      .select(['id', 'label'])
      .where('asset_id', '=', assetId)
      .where('status', '=', 'ACTIVE')
      .orderBy('label')
      .execute();
    return {
      assetId: row.id,
      status: row.status as AssetStatus,
      title: row.title,
      assetType: row.asset_type as AssetType,
      hostAccountId: row.host_account_id,
      propertyId: row.property_id,
      bufferMinutes: row.buffer_minutes,
      approvalRequired: row.approval_required,
      minMinutes: row.min_minutes,
      maxMinutes: row.max_minutes,
      leadMinutes: row.lead_minutes,
      cancellationPolicy: row.cancellation_policy_code as 'FLEXIBLE' | 'MODERATE' | 'STRICT',
      maxVehicleClass: row.max_vehicle_class as 'HATCHBACK' | 'SEDAN' | 'SUV' | 'MUV',
      connectors: row.connectors ?? [],
      units,
    };
  }

  /** Private access details for a confirmed booking's customer (L-6); callers enforce the reveal window. */
  async function revealAccess(assetId: string, unitId: string) {
    const row = await db
      .selectFrom('assets.assets as a')
      .innerJoin('assets.asset_units as u', 'u.asset_id', 'a.id')
      .select(['a.access_instructions_enc', 'u.label'])
      .where('a.id', '=', assetId)
      .where('u.id', '=', unitId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      unitLabel: row.label,
      accessInstructions: row.access_instructions_enc
        ? cipher.decrypt(row.access_instructions_enc, ACCESS_CONTEXT)
        : null,
    };
  }

  /** Charger facts for the charging module (session start/stop through the right integration). */
  async function chargerProfile(assetId: string) {
    const row = await db
      .selectFrom('assets.charger_details')
      .selectAll()
      .where('asset_id', '=', assetId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      connectors: row.connectors,
      currentType: row.current_type as 'AC' | 'DC',
      powerKw: Number(row.power_kw),
      cableProvided: row.cable_provided,
      meteringSource: row.metering_source as 'NONE' | 'HOST_REPORTED' | 'CHARGER_API',
      integrationKind: row.integration_kind as 'MANUAL',
      integrationRef: row.integration_ref,
    };
  }

  async function unitLabel(unitId: string): Promise<string | null> {
    const row = await db
      .selectFrom('assets.asset_units')
      .select('label')
      .where('id', '=', unitId)
      .executeTakeFirst();
    return row?.label ?? null;
  }

  // ------------------------------------------------------------------ photos

  async function addPhoto(
    host: Host,
    assetId: string,
    input: {
      kind: MediaKind;
      body: Buffer;
      capturedAt?: { latitude: number; longitude: number } | undefined;
    },
    requestId: string,
  ) {
    await deps.rateLimiter.enforce({
      key: `media-upload:host1h:${host.hostAccountId}`,
      limit: 60,
      windowSeconds: 3600,
    });
    const owned = await db
      .selectFrom('assets.assets')
      .select(['id', 'asset_type', 'property_id', 'status'])
      .where('id', '=', assetId)
      .where('host_account_id', '=', host.hostAccountId)
      .executeTakeFirst();
    if (!owned) throw errors.notFound();
    if (owned.status === 'ARCHIVED') throw assetErrors.archived();
    if (input.kind === 'CHARGER' && owned.asset_type !== 'EV_CHARGING')
      throw assetErrors.wrongType('Charger photos apply to EV charging listings.');

    // Decode + re-encode before anything is stored (strips EXIF/GPS, rejects non-images).
    const image = await processListingPhoto(input.body);

    let captureDistance: number | null = null;
    if (input.capturedAt) {
      const exact = await deps.properties.exactPoint(owned.property_id);
      if (exact) captureDistance = Math.round(haversineMeters(exact, input.capturedAt));
    }

    const mediaId = uuidv7();
    const storageKey = `assets/${assetId}/${mediaId}.webp`;
    await storage.put(storageKey, image.data, 'image/webp');
    try {
      await db.transaction().execute(async (trx) => {
        const asset = await lockOwned(trx, host, assetId);
        const count = await trx
          .selectFrom('assets.asset_media')
          .select(sql<number>`count(*)::int`.as('n'))
          .where('asset_id', '=', assetId)
          .where('removed_at', 'is', null)
          .executeTakeFirstOrThrow();
        if (count.n >= MAX_PHOTOS_PER_ASSET) throw assetErrors.photoLimit();

        // Near-duplicate of another host's photo → flagged for the reviewer, not blocked (same society, etc.).
        const duplicate = await trx
          .selectFrom('assets.asset_media as m')
          .innerJoin('assets.assets as a', 'a.id', 'm.asset_id')
          .select('m.id')
          .where('a.host_account_id', '<>', host.hostAccountId)
          .where(
            sql<boolean>`bit_count((m.phash # ${image.phash}::bigint)::bit(64)) <= ${DUPLICATE_HAMMING_THRESHOLD}`,
          )
          .limit(1)
          .executeTakeFirst();

        await trx
          .insertInto('assets.asset_media')
          .values({
            id: mediaId,
            asset_id: assetId,
            kind: input.kind,
            storage_key: storageKey,
            content_type: 'image/webp',
            width: image.width,
            height: image.height,
            byte_size: image.data.length,
            sha256: image.sha256,
            phash: image.phash,
            duplicate_suspected: duplicate !== undefined,
            capture_distance_m: captureDistance,
            position: count.n,
          })
          .execute();
        // Photos are a material change: a live listing goes back to review (trust-and-safety §4.4).
        await materialChange(trx, asset, { kind: 'HOST', userId: host.userId }, 'photo added', requestId);
        await audit.record(
          {
            actorKind: 'USER',
            actorId: host.userId,
            action: 'asset.photo_added',
            entityKind: 'asset',
            entityId: assetId,
            metadata: { mediaId, kind: input.kind, duplicateSuspected: duplicate !== undefined },
            requestId,
          },
          trx,
        );
      });
    } catch (error) {
      await storage.delete(storageKey); // don't leave orphaned objects
      throw error;
    }
    return getHostAsset(host, assetId);
  }

  async function removePhoto(host: Host, assetId: string, mediaId: string, requestId: string) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      const result = await trx
        .updateTable('assets.asset_media')
        .set({ removed_at: sql<Date>`now()` })
        .where('id', '=', mediaId)
        .where('asset_id', '=', assetId)
        .where('removed_at', 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) throw errors.notFound();
      await materialChange(trx, asset, { kind: 'HOST', userId: host.userId }, 'photo removed', requestId);
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'asset.photo_removed',
          entityKind: 'asset',
          entityId: assetId,
          metadata: { mediaId },
          requestId,
        },
        trx,
      );
    });
    // The object itself is deleted by the retention job (Phase 12); disputes may need it until then.
    return getHostAsset(host, assetId);
  }

  /**
   * Media access (L-5, §11): the owning host sees all of their photos; anyone else only APPROVED, non-ENTRANCE
   * photos of PUBLISHED listings. Everything else is "not found".
   */
  async function readMedia(mediaId: string, viewer: { hostAccountId: string | null; isAdmin: boolean }) {
    const row = await db
      .selectFrom('assets.asset_media as m')
      .innerJoin('assets.assets as a', 'a.id', 'm.asset_id')
      .select(['m.storage_key', 'm.kind', 'm.moderation_status', 'a.status', 'a.host_account_id'])
      .where('m.id', '=', mediaId)
      .where('m.removed_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw errors.notFound();
    const isOwner = viewer.hostAccountId !== null && viewer.hostAccountId === row.host_account_id;
    const isPublic =
      row.status === 'PUBLISHED' && row.kind !== 'ENTRANCE' && row.moderation_status === 'APPROVED';
    if (!isOwner && !viewer.isAdmin && !isPublic) throw errors.notFound();
    const data = await storage.get(row.storage_key);
    if (!data) throw errors.notFound();
    return { data, cacheable: isPublic && !isOwner && !viewer.isAdmin };
  }

  // ------------------------------------------------------------------ lifecycle (host)

  async function hostAction(
    host: Host,
    assetId: string,
    action: 'SUBMIT' | 'PAUSE' | 'REPUBLISH' | 'ARCHIVE',
    requestId: string,
  ) {
    const needsChecklist = action === 'SUBMIT' || action === 'REPUBLISH';
    if (needsChecklist) {
      const current = await getHostAsset(host, assetId);
      if (!transition(current.status, action, { needsReview: current.needsReview })) {
        throw assetErrors.transitionNotAllowed(current.status, action);
      }
      if (!current.checklist.ready) throw assetErrors.notReady(current.checklist.missing);
    }
    await db.transaction().execute(async (trx) => {
      const asset = await lockOwned(trx, host, assetId);
      if (action === 'ARCHIVE') {
        // D-071: archive only once nothing is booked. The asset lock waits for in-flight bookings (FOR SHARE).
        const units = await trx
          .selectFrom('assets.asset_units')
          .select('id')
          .where('asset_id', '=', assetId)
          .execute();
        const upcoming = await deps.reservations.holdingReservations(
          units.map((u) => u.id),
          now(),
          now() + 400 * 86_400_000,
          trx,
        );
        if (upcoming.some((r) => r.blockedUntil > now())) throw assetErrors.hasUpcomingBookings();
      }
      const to = await applyTransition(
        trx,
        asset,
        action,
        { kind: 'HOST', userId: host.userId },
        { requestId },
      );
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: `asset.${action.toLowerCase()}`,
          entityKind: 'asset',
          entityId: assetId,
          metadata: { to },
          requestId,
        },
        trx,
      );
    });
    return getHostAsset(host, assetId);
  }

  // ------------------------------------------------------------------ admin review (AJ-1)

  /** Admin list (Phase 20) and fraud indicators (duplicate photos across hosts). */
  async function adminList(f: {
    q?: string | undefined;
    status?: string | undefined;
    type?: string | undefined;
    hostAccountId?: string | undefined;
    offset: number;
    limit: number;
  }) {
    let q = db.selectFrom('assets.assets');
    if (f.q) q = q.where('title', 'ilike', `%${f.q}%`);
    if (f.status) q = q.where('status', '=', f.status);
    if (f.type) q = q.where('asset_type', '=', f.type);
    if (f.hostAccountId) q = q.where('host_account_id', '=', f.hostAccountId);
    const [rows, total] = await Promise.all([
      q
        .select(['id', 'title', 'asset_type', 'status', 'host_account_id', 'property_id', 'updated_at'])
        .orderBy('updated_at', 'desc')
        .offset(f.offset)
        .limit(f.limit)
        .execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.asset_type,
        status: r.status,
        hostAccountId: r.host_account_id,
        propertyId: r.property_id,
        updatedAt: r.updated_at,
      })),
      offset: f.offset,
      limit: f.limit,
      total: Number(total.n),
    };
  }

  async function riskSignals() {
    const rows = await db
      .selectFrom('assets.asset_media as m')
      .innerJoin('assets.assets as a', 'a.id', 'm.asset_id')
      .select(['a.id', 'a.title', sql<string>`count(*)`.as('n')])
      .where('m.duplicate_suspected', '=', true)
      .where('a.status', '<>', 'ARCHIVED')
      .groupBy(['a.id', 'a.title'])
      .execute();
    return rows.map((r) => ({
      kind: 'DUPLICATE_PHOTOS',
      subject: { kind: 'asset', id: r.id },
      count: Number(r.n),
      detail: `${r.n} photo(s) match another host's listing: ${r.title}`,
    }));
  }

  async function reviewQueue() {
    const rows = await db
      .selectFrom('assets.assets')
      .select(['id', 'asset_type', 'title', 'host_account_id', 'property_id', 'updated_at'])
      .where('status', '=', 'PENDING_REVIEW')
      .orderBy('updated_at')
      .execute();
    return Promise.all(rows.map((r) => adminAsset(r.id)));
  }

  async function adminAsset(assetId: string) {
    const s = await snapshot(assetId);
    return {
      ...view(s, checklistFor(s, { canPublish: true }, true)),
      accessInstructions: undefined,
      hostAccountId: s.asset.host_account_id,
      media: s.media.map((m) => ({
        id: m.id,
        kind: m.kind as MediaKind,
        moderationStatus: m.moderation_status as 'PENDING' | 'APPROVED' | 'REJECTED',
        width: m.width,
        height: m.height,
        url: `/api/admin/media/${m.id}`,
        duplicateSuspected: m.duplicate_suspected,
        captureDistanceM: m.capture_distance_m,
        createdAt: m.created_at,
      })),
    };
  }

  async function adminAction(
    admin: { userId: string },
    assetId: string,
    action: 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE',
    reason: string | undefined,
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const asset = await lockAny(trx, assetId);
      // Is the action valid for the current status at all? (409) Only then: is the listing ready? (422)
      if (!transition(asset.status as AssetStatus, action, { needsReview: asset.needs_review })) {
        throw assetErrors.transitionNotAllowed(asset.status, action);
      }
      if (action === 'APPROVE') {
        // Re-check against the host's real state (society consent may have changed since submission).
        const s = await snapshot(assetId);
        const listing = await deps.properties.listingContext(asset.property_id, asset.host_account_id);
        const checklist = checklistFor(s, listing, true);
        if (!checklist.ready) throw assetErrors.notReady(checklist.missing);
        await trx
          .updateTable('assets.asset_media')
          .set({ moderation_status: 'APPROVED' })
          .where('asset_id', '=', assetId)
          .where('removed_at', 'is', null)
          .where('moderation_status', '=', 'PENDING')
          .execute();
        await deps.trust.record(
          {
            subjectKind: 'ASSET',
            subjectId: assetId,
            kind: 'PHOTO_REVIEW',
            method: 'ADMIN_REVIEW',
            status: 'VERIFIED',
            actorId: admin.userId,
            note: reason,
          },
          trx,
        );
      }
      const to = await applyTransition(
        trx,
        asset,
        action,
        { kind: 'PLATFORM_ADMIN', userId: admin.userId },
        { reason, requestId },
      );
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: `asset.${action.toLowerCase()}`,
          entityKind: 'asset',
          entityId: assetId,
          metadata: { to },
          requestId,
        },
        trx,
      );
    });
    return adminAsset(assetId);
  }

  async function adminReadMedia(mediaId: string) {
    return readMedia(mediaId, { hostAccountId: null, isAdmin: true });
  }

  // ------------------------------------------------------------------ reactions to property events

  async function onPropertyLocationChanged(
    e: { propertyId: string; actorId: string; requestId: string },
    executor: AnyKyselyExecutor,
  ) {
    const trx = executor as unknown as Kysely<AssetsDb>;
    const assets = await trx
      .selectFrom('assets.assets')
      .select(['id', 'status', 'needs_review'])
      .where('property_id', '=', e.propertyId)
      .forUpdate()
      .execute();
    for (const asset of assets) {
      await materialChange(
        trx,
        asset,
        { kind: 'HOST', userId: e.actorId },
        'property location changed',
        e.requestId,
      );
    }
  }

  async function suspendAt(
    executor: AnyKyselyExecutor,
    propertyId: string,
    hostAccountId: string | null,
    reason: string,
    requestId: string,
  ) {
    const trx = executor as unknown as Kysely<AssetsDb>;
    let query = trx
      .selectFrom('assets.assets')
      .select(['id', 'status', 'needs_review'])
      .where('property_id', '=', propertyId)
      .where('status', 'in', ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'PAUSED']);
    if (hostAccountId) query = query.where('host_account_id', '=', hostAccountId);
    for (const asset of await query.forUpdate().execute()) {
      await applyTransition(trx, asset, 'SUSPEND', { kind: 'SYSTEM', userId: null }, { reason, requestId });
    }
  }

  deps.events.subscribe('property.location_changed', onPropertyLocationChanged);
  deps.events.subscribe('property.participation_changed', async (e, executor) => {
    if (participationHaltsListings(e.to)) {
      await suspendAt(
        executor,
        e.propertyId,
        null,
        `society participation ${e.to.toLowerCase()}`,
        e.requestId,
      );
    }
  });
  deps.events.subscribe('property.member_revoked', async (e, executor) => {
    await suspendAt(executor, e.propertyId, e.hostAccountId, 'society membership revoked', e.requestId);
  });

  return {
    adminList,
    riskSignals,
    createAsset,
    getHostAsset,
    listHostAssets,
    updateAsset,
    setParkingDetails,
    setChargerDetails,
    setUnits,
    setRates,
    setAvailabilityRules,
    attest,
    addException,
    removeException,
    calendar,
    bookingContext,
    revealAccess,
    unitLabel,
    chargerProfile,
    addPhoto,
    removePhoto,
    readMedia,
    hostAction,
    reviewQueue,
    adminAsset,
    adminAction,
    adminReadMedia,
  };
}

export type AssetService = ReturnType<typeof createAssetService>;
