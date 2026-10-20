import { sql, type Kysely } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../../platform/crypto/field-cipher.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import {
  formatPoint,
  fuzzPoint,
  isInIndia,
  parsePoint,
  type LatLng,
  type PropertyKind,
} from '../domain/geo.ts';
import { canTransitionParticipation, type ParticipationStatus } from '../domain/participation.ts';
import type { PropertiesDb } from '../infrastructure/tables.ts';
import '../domain/events.ts';

const ADDRESS_CONTEXT = 'properties.exact_address';
const POINT_CONTEXT = 'properties.exact_point';

export interface PropertyInput {
  address: string;
  latitude: number;
  longitude: number;
  areaLabel: string;
  timezone: string;
}

export interface ListingContext {
  propertyId: string;
  kind: PropertyKind;
  timezone: string;
  participationStatus: ParticipationStatus;
  /** The host may create and edit listings here. */
  canDraft: boolean;
  /** The host may publish listings here right now (society consent, BR-32). */
  canPublish: boolean;
  publishBlockedReason: 'SOCIETY_NOT_PARTICIPATING' | null;
}

export const propertyErrors = {
  outsideServiceArea: () =>
    new DomainError({
      code: 'property.outside_service_area',
      status: 400,
      title: 'This location is outside the service area',
      detail: 'We currently operate in India only.',
    }),
  invalidTimezone: () =>
    new DomainError({ code: 'property.invalid_timezone', status: 400, title: 'Unknown time zone' }),
  transitionNotAllowed: (from: string, to: string) =>
    new DomainError({
      code: 'property.transition_not_allowed',
      status: 409,
      title: 'That change is not allowed',
      detail: `Participation cannot move from ${from} to ${to}.`,
    }),
};

/**
 * Accepts any IANA zone name the runtime knows, including aliases. Note: Intl.supportedValuesOf('timeZone') lists
 * only ICU-canonical names (it has "Asia/Calcutta", not "Asia/Kolkata"), so it can't be used for validation.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function validateLocation(input: Pick<PropertyInput, 'latitude' | 'longitude' | 'timezone'>) {
  if (!isInIndia(input)) throw propertyErrors.outsideServiceArea();
  if (!isValidTimezone(input.timezone)) throw propertyErrors.invalidTimezone();
}

const publicPointSql = (p: LatLng) =>
  sql`ST_SetSRID(ST_MakePoint(${p.longitude}, ${p.latitude}), 4326)::geography`;

/** Properties (domain-model §3.2): sites containing assets, with private exact location and a stable public point. */
export function createPropertyService(deps: {
  db: Kysely<PropertiesDb>;
  cipher: FieldCipher;
  audit: AuditLog;
  events: DomainEventBus;
  random?: () => number;
}) {
  const { db, cipher, audit, events } = deps;
  const random = deps.random ?? Math.random;

  const baseSelect = () =>
    db
      .selectFrom('properties.properties as p')
      .select([
        'p.id',
        'p.kind',
        'p.display_name',
        'p.exact_address_enc',
        'p.exact_point_enc',
        'p.area_label',
        'p.timezone',
        'p.participation_status',
        'p.owner_host_account_id',
        'p.outsider_cap',
        'p.version',
        'p.created_at',
        sql<number>`ST_Y(p.public_point::geometry)`.as('public_lat'),
        sql<number>`ST_X(p.public_point::geometry)`.as('public_lng'),
      ]);

  type Row = NonNullable<Awaited<ReturnType<ReturnType<typeof baseSelect>['executeTakeFirst']>>>;

  /** Full view for the owning host or a member host (they already know the address). Never public. */
  function hostView(row: Row, relation: 'OWNER' | 'MEMBER_HOST') {
    return {
      id: row.id,
      kind: row.kind as PropertyKind,
      displayName: row.display_name,
      relation,
      address: cipher.decrypt(row.exact_address_enc, ADDRESS_CONTEXT),
      exactPoint: parsePoint(cipher.decrypt(row.exact_point_enc, POINT_CONTEXT)),
      // What customers will see: the fuzzed point (never the exact one) and the area label.
      publicPoint: { latitude: row.public_lat, longitude: row.public_lng },
      areaLabel: row.area_label,
      timezone: row.timezone,
      participationStatus: row.participation_status as ParticipationStatus,
      version: row.version,
      createdAt: row.created_at,
    };
  }

  async function relationOf(propertyId: string, hostAccountId: string) {
    const row = await baseSelect().where('p.id', '=', propertyId).executeTakeFirst();
    if (!row) return null;
    if (row.owner_host_account_id === hostAccountId) return { row, relation: 'OWNER' as const };
    const member = await db
      .selectFrom('properties.property_members')
      .select('status')
      .where('property_id', '=', propertyId)
      .where('host_account_id', '=', hostAccountId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return member ? { row, relation: 'MEMBER_HOST' as const } : null;
  }

  async function createHostProperty(
    host: { hostAccountId: string; userId: string },
    input: PropertyInput & { kind: Exclude<PropertyKind, 'APARTMENT_SOCIETY'> },
    requestId: string,
  ) {
    validateLocation(input);
    const id = uuidv7();
    const exact = { latitude: input.latitude, longitude: input.longitude };
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('properties.properties')
        .values({
          id,
          kind: input.kind,
          exact_address_enc: cipher.encrypt(input.address, ADDRESS_CONTEXT),
          exact_point_enc: cipher.encrypt(formatPoint(exact), POINT_CONTEXT),
          public_point: publicPointSql(fuzzPoint(exact, input.kind, random)),
          area_label: input.areaLabel,
          timezone: input.timezone,
          participation_status: 'NOT_REQUIRED',
          owner_host_account_id: host.hostAccountId,
          created_by: host.userId,
        })
        .execute();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'property.created',
          entityKind: 'property',
          entityId: id,
          metadata: { kind: input.kind },
          requestId,
        },
        trx,
      );
    });
    return getHostProperty(id, host.hostAccountId);
  }

  async function getHostProperty(propertyId: string, hostAccountId: string) {
    const found = await relationOf(propertyId, hostAccountId);
    if (!found) throw errors.notFound();
    return hostView(found.row, found.relation);
  }

  async function listHostProperties(hostAccountId: string) {
    const owned = await baseSelect()
      .where('p.owner_host_account_id', '=', hostAccountId)
      .orderBy('p.created_at')
      .execute();
    const member = await baseSelect()
      .innerJoin('properties.property_members as m', 'm.property_id', 'p.id')
      .where('m.host_account_id', '=', hostAccountId)
      .where('m.status', '=', 'ACTIVE')
      .orderBy('p.created_at')
      .execute();
    return [...owned.map((r) => hostView(r, 'OWNER')), ...member.map((r) => hostView(r, 'MEMBER_HOST'))];
  }

  /** Only the owning host edits a property; society properties are edited by platform admins. */
  async function updateHostProperty(
    propertyId: string,
    host: { hostAccountId: string; userId: string },
    changes: { [K in keyof PropertyInput]?: PropertyInput[K] | undefined } & { version: number },
    requestId: string,
  ) {
    const found = await relationOf(propertyId, host.hostAccountId);
    if (!found || found.relation !== 'OWNER') throw errors.notFound();
    const current = hostView(found.row, 'OWNER');
    const next = {
      address: changes.address ?? current.address,
      latitude: changes.latitude ?? current.exactPoint.latitude,
      longitude: changes.longitude ?? current.exactPoint.longitude,
      areaLabel: changes.areaLabel ?? current.areaLabel,
      timezone: changes.timezone ?? current.timezone,
    };
    validateLocation(next);
    const pointChanged =
      formatPoint(next) !== formatPoint(current.exactPoint) || next.address.trim() !== current.address.trim();

    await db.transaction().execute(async (trx) => {
      const exact = { latitude: next.latitude, longitude: next.longitude };
      const updated = await trx
        .updateTable('properties.properties')
        .set({
          exact_address_enc: cipher.encrypt(next.address, ADDRESS_CONTEXT),
          exact_point_enc: cipher.encrypt(formatPoint(exact), POINT_CONTEXT),
          // A new random offset only when the real location changes (L-1).
          ...(formatPoint(exact) !== formatPoint(current.exactPoint)
            ? { public_point: publicPointSql(fuzzPoint(exact, current.kind, random)) }
            : {}),
          area_label: next.areaLabel,
          timezone: next.timezone,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', propertyId)
        .where('version', '=', changes.version)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) throw errors.stale();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: host.userId,
          action: 'property.updated',
          entityKind: 'property',
          entityId: propertyId,
          metadata: { locationChanged: pointChanged },
          requestId,
        },
        trx,
      );
      if (pointChanged) {
        await events.publish(
          'property.location_changed',
          { propertyId, actorId: host.userId, requestId },
          trx,
        );
      }
    });
    return getHostProperty(propertyId, host.hostAccountId);
  }

  /** Listing rules for a host at a property (BR-32): who may draft here and whether publishing is allowed now. */
  async function listingContext(propertyId: string, hostAccountId: string): Promise<ListingContext | null> {
    const found = await relationOf(propertyId, hostAccountId);
    if (!found) return null;
    const status = found.row.participation_status as ParticipationStatus;
    const isSociety = found.row.kind === 'APARTMENT_SOCIETY';
    const canPublish = !isSociety || status === 'PARTICIPATING';
    return {
      propertyId,
      kind: found.row.kind as PropertyKind,
      timezone: found.row.timezone,
      participationStatus: status,
      canDraft: status !== 'WITHDRAWN',
      canPublish,
      publishBlockedReason: canPublish ? null : 'SOCIETY_NOT_PARTICIPATING',
    };
  }

  /**
   * Booking transaction step 1 (lock order property → asset → bookings, database-design §6.4): a property with an
   * outsider cap is row-locked FOR UPDATE so concurrent bookings there serialise (BR-06, validated C16).
   */
  async function lockForBooking(propertyId: string, executor: unknown) {
    const trx = executor as Kysely<PropertiesDb>;
    const row = await trx
      .selectFrom('properties.properties')
      .select(['timezone', 'outsider_cap', 'participation_status'])
      .where('id', '=', propertyId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.outsider_cap !== null) {
      await trx
        .selectFrom('properties.properties')
        .select('id')
        .where('id', '=', propertyId)
        .forUpdate()
        .execute();
    }
    return {
      timezone: row.timezone,
      outsiderCap: row.outsider_cap,
      participationStatus: row.participation_status as ParticipationStatus,
    };
  }

  /** Exact address, revealed to a customer only with a confirmed booking in its window (L-6). */
  async function exactAddress(propertyId: string): Promise<string | null> {
    const row = await db
      .selectFrom('properties.properties')
      .select('exact_address_enc')
      .where('id', '=', propertyId)
      .executeTakeFirst();
    return row ? cipher.decrypt(row.exact_address_enc, ADDRESS_CONTEXT) : null;
  }

  async function timezoneOf(propertyId: string): Promise<string | null> {
    const row = await db
      .selectFrom('properties.properties')
      .select('timezone')
      .where('id', '=', propertyId)
      .executeTakeFirst();
    return row?.timezone ?? null;
  }

  /** Exact point for verification (V-GEO); internal use only, never returned to the public. */
  async function exactPoint(propertyId: string): Promise<LatLng | null> {
    const row = await db
      .selectFrom('properties.properties')
      .select('exact_point_enc')
      .where('id', '=', propertyId)
      .executeTakeFirst();
    return row ? parsePoint(cipher.decrypt(row.exact_point_enc, POINT_CONTEXT)) : null;
  }

  // ------------------------------------------------------------------ admin: societies (PJ-1)

  async function createSociety(
    admin: { userId: string },
    input: PropertyInput & { displayName: string | null; outsiderCap: number | null },
    requestId: string,
  ) {
    validateLocation(input);
    const id = uuidv7();
    const exact = { latitude: input.latitude, longitude: input.longitude };
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('properties.properties')
        .values({
          id,
          kind: 'APARTMENT_SOCIETY',
          display_name: input.displayName,
          exact_address_enc: cipher.encrypt(input.address, ADDRESS_CONTEXT),
          exact_point_enc: cipher.encrypt(formatPoint(exact), POINT_CONTEXT),
          public_point: publicPointSql(fuzzPoint(exact, 'APARTMENT_SOCIETY', random)),
          area_label: input.areaLabel,
          timezone: input.timezone,
          participation_status: 'CONSENT_REQUIRED',
          owner_host_account_id: null,
          outsider_cap: input.outsiderCap,
          created_by: admin.userId,
        })
        .execute();
      await trx
        .insertInto('properties.property_events')
        .values({
          property_id: id,
          from_status: null,
          to_status: 'CONSENT_REQUIRED',
          actor_id: admin.userId,
          reason: 'created',
          request_id: requestId,
        })
        .execute();
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: 'property.society_created',
          entityKind: 'property',
          entityId: id,
          requestId,
        },
        trx,
      );
    });
    return adminView(id);
  }

  /**
   * Admin detail incl. the exact address. Opening it is a PII reveal and is audited (R-56, trust-and-safety §14);
   * `reveal` is omitted only when an audited admin action returns the updated view.
   */
  async function adminView(propertyId: string, reveal?: { adminId: string; requestId: string }) {
    const row = await baseSelect().where('p.id', '=', propertyId).executeTakeFirst();
    if (!row) throw errors.notFound();
    if (reveal) {
      await audit.record({
        actorKind: 'ADMIN',
        actorId: reveal.adminId,
        action: 'property.address_viewed',
        entityKind: 'property',
        entityId: propertyId,
        requestId: reveal.requestId,
      });
    }
    const members = await db
      .selectFrom('properties.property_members')
      .select(['host_account_id', 'status'])
      .where('property_id', '=', propertyId)
      .execute();
    return {
      ...hostView(row, 'OWNER'),
      relation: undefined,
      outsiderCap: row.outsider_cap,
      memberHosts: members.map((m) => ({
        hostAccountId: m.host_account_id,
        status: m.status as 'ACTIVE' | 'REVOKED',
      })),
    };
  }

  async function setParticipation(
    admin: { userId: string },
    propertyId: string,
    to: ParticipationStatus,
    reason: string,
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('properties.properties')
        .select(['participation_status', 'kind'])
        .where('id', '=', propertyId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw errors.notFound();
      const from = row.participation_status as ParticipationStatus;
      if (!canTransitionParticipation(from, to)) throw propertyErrors.transitionNotAllowed(from, to);
      await trx
        .updateTable('properties.properties')
        .set({ participation_status: to, version: sql<number>`version + 1` })
        .where('id', '=', propertyId)
        .execute();
      await trx
        .insertInto('properties.property_events')
        .values({
          property_id: propertyId,
          from_status: from,
          to_status: to,
          actor_id: admin.userId,
          reason,
          request_id: requestId,
        })
        .execute();
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: 'property.participation_changed',
          entityKind: 'property',
          entityId: propertyId,
          metadata: { from, to },
          requestId,
        },
        trx,
      );
      await events.publish(
        'property.participation_changed',
        { propertyId, from, to, actorId: admin.userId, requestId },
        trx,
      );
    });
    return adminView(propertyId);
  }

  async function addMemberHost(
    admin: { userId: string },
    propertyId: string,
    hostAccountId: string,
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const property = await trx
        .selectFrom('properties.properties')
        .select('kind')
        .where('id', '=', propertyId)
        .executeTakeFirst();
      if (!property) throw errors.notFound();
      if (property.kind !== 'APARTMENT_SOCIETY') {
        throw new DomainError({
          code: 'property.not_a_society',
          status: 400,
          title: 'Only societies have member hosts',
        });
      }
      await trx
        .insertInto('properties.property_members')
        .values({
          property_id: propertyId,
          host_account_id: hostAccountId,
          role: 'MEMBER_HOST',
          approved_by: admin.userId,
        })
        .onConflict((oc) =>
          oc
            .columns(['property_id', 'host_account_id'])
            .doUpdateSet({ status: 'ACTIVE', approved_by: admin.userId }),
        )
        .execute();
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: 'property.member_added',
          entityKind: 'property',
          entityId: propertyId,
          metadata: { hostAccountId },
          requestId,
        },
        trx,
      );
    });
    return adminView(propertyId);
  }

  async function revokeMemberHost(
    admin: { userId: string },
    propertyId: string,
    hostAccountId: string,
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('properties.property_members')
        .set({ status: 'REVOKED' })
        .where('property_id', '=', propertyId)
        .where('host_account_id', '=', hostAccountId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) throw errors.notFound();
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.userId,
          action: 'property.member_revoked',
          entityKind: 'property',
          entityId: propertyId,
          metadata: { hostAccountId },
          requestId,
        },
        trx,
      );
      await events.publish(
        'property.member_revoked',
        { propertyId, hostAccountId, actorId: admin.userId, requestId },
        trx,
      );
    });
    return adminView(propertyId);
  }

  /** Admin list (Phase 20): locality, kind, participation; no exact address in lists. */
  async function adminList(f: {
    q?: string | undefined;
    kind?: string | undefined;
    participation?: string | undefined;
    offset: number;
    limit: number;
  }) {
    let q = db.selectFrom('properties.properties');
    if (f.q)
      q = q.where((eb) =>
        eb.or([eb('area_label', 'ilike', `%${f.q}%`), eb('display_name', 'ilike', `%${f.q}%`)]),
      );
    if (f.kind) q = q.where('kind', '=', f.kind);
    if (f.participation) q = q.where('participation_status', '=', f.participation);
    const [rows, total] = await Promise.all([
      q
        .select(['id', 'kind', 'display_name', 'area_label', 'participation_status', 'created_at'])
        .orderBy('created_at', 'desc')
        .offset(f.offset)
        .limit(f.limit)
        .execute(),
      q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow(),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        displayName: r.display_name,
        areaLabel: r.area_label,
        participationStatus: r.participation_status,
        createdAt: r.created_at,
      })),
      offset: f.offset,
      limit: f.limit,
      total: Number(total.n),
    };
  }

  return {
    adminList,
    createHostProperty,
    getHostProperty,
    listHostProperties,
    updateHostProperty,
    listingContext,
    timezoneOf,
    lockForBooking,
    exactAddress,
    exactPoint,
    createSociety,
    adminView,
    setParticipation,
    addMemberHost,
    revokeMemberHost,
  };
}

export type PropertyService = ReturnType<typeof createPropertyService>;
