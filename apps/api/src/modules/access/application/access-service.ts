import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { AnyKyselyExecutor, AuditLog } from '../../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../../platform/crypto/field-cipher.ts';
import type { KeyedHasher } from '../../../platform/crypto/keyed-hash.ts';
import { DomainError, errors } from '../../../platform/errors/domain-error.ts';
import type { DomainEventBus } from '../../../platform/events/domain-events.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import type { AssetsModule } from '../../assets/index.ts';
import type { BookingModule } from '../../booking/index.ts';
import type { HostAccess } from '../../identity/index.ts';
import type { PropertiesModule } from '../../properties/index.ts';
import { formatPlate, normalizePlate, type UsersModule } from '../../users/index.ts';
import {
  effectiveGrantStatus,
  ENTRY_TICKET_MINUTES,
  formatCode,
  GATE_TOKEN_DAYS,
  grantWindow,
  REVEAL_AFTER_MS,
  verifies,
  type AccessMethod,
  type StoredStatus,
} from '../domain/access.ts';
import type { AccessAdapters, ExternalAccessEvent } from '../domain/adapters.ts';
import type { AccessDb, AccessGrantsTable } from '../infrastructure/tables.ts';

type Grant = Selectable<AccessGrantsTable>;
type Host = HostAccess & { userId: string };
const CODE_CONTEXT = 'access.access_grants.code';

export const accessErrors = {
  notAvailable: () =>
    new DomainError({
      code: 'access.not_available',
      status: 409,
      title: 'Access details are available once your booking is confirmed',
    }),
  outsideWindow: () =>
    new DomainError({
      code: 'access.outside_window',
      status: 409,
      title: 'Your access window is not open',
      detail: 'You can check in from 15 minutes before your booking starts until it ends.',
    }),
  invalidGate: () =>
    new DomainError({
      code: 'access.invalid_gate',
      status: 401,
      title: 'This gate link is not valid',
      detail: 'Ask the owner for a new link.',
    }),
  invalidTicket: () =>
    new DomainError({ code: 'access.invalid_ticket', status: 400, title: 'Check the vehicle again' }),
  invalidPass: () =>
    new DomainError({ code: 'access.invalid_pass', status: 404, title: 'This pass is no longer valid' }),
  ownerOnly: () =>
    new DomainError({
      code: 'access.owner_only',
      status: 403,
      title: 'Only the property owner can manage gate links',
      detail: 'For apartment societies, the society admin manages gates.',
    }),
};

/**
 * Access management (Phase 17). Grants are issued only from a confirmed booking and revoked when it closes; every
 * check, entry and check-in is an access event. Credentials are hashed for lookup and encrypted for display; guard
 * answers contain only valid/not valid, the space label, the end time and the expected plate (trust-and-safety §10).
 */
export function createAccessService(deps: {
  db: Kysely<AccessDb>;
  audit: AuditLog;
  cipher: FieldCipher;
  hasher: KeyedHasher;
  rateLimiter: RateLimiter;
  events: DomainEventBus;
  booking: Pick<BookingModule, 'checkIn'>;
  users: Pick<UsersModule, 'plateKeys' | 'plateIndex' | 'vehicleById'>;
  assets: Pick<AssetsModule, 'unitLabel' | 'revealAccess'>;
  properties: Pick<PropertiesModule, 'exactAddress' | 'hostRelation'>;
  adapters: AccessAdapters;
  now?: () => number;
}) {
  const { db, audit, cipher, hasher } = deps;
  const now = deps.now ?? Date.now;
  const x = (executor?: AnyKyselyExecutor) => (executor as unknown as Kysely<AccessDb> | undefined) ?? db;
  const codeIndex = (propertyId: string, code: string) => hasher.hash('access.code', `${propertyId}:${code}`);
  const tokenHash = (token: string) => createHash('sha256').update(token).digest();
  const windowOf = (g: Grant) => ({ from: g.valid_from.getTime(), until: g.valid_until.getTime() });

  async function logEvent(
    executor: AnyKyselyExecutor | undefined,
    e: {
      propertyId: string;
      grantId?: string | null;
      gateId?: string | null;
      kind: string;
      source: string;
      method?: string | null;
      inputHash?: Buffer | null;
      detail?: string | null;
    },
  ) {
    await x(executor)
      .insertInto('access.access_events')
      .values({
        property_id: e.propertyId,
        grant_id: e.grantId ?? null,
        gate_id: e.gateId ?? null,
        kind: e.kind,
        source: e.source,
        method: e.method ?? null,
        input_hash: e.inputHash ?? null,
        detail: e.detail ?? null,
      })
      .execute();
  }

  /** A fresh 6-digit code that no other live grant at the property uses in an overlapping window. */
  async function freshCode(
    executor: AnyKyselyExecutor | undefined,
    propertyId: string,
    from: Date,
    until: Date,
  ) {
    for (let i = 0; i < 10; i += 1) {
      const code = formatCode(randomInt(0, 1_000_000));
      const clash = await x(executor)
        .selectFrom('access.access_grants')
        .select('id')
        .where('property_id', '=', propertyId)
        .where('code_hmac', '=', codeIndex(propertyId, code))
        .where('status', '<>', 'REVOKED')
        .where('valid_from', '<', until)
        .where('valid_until', '>', from)
        .executeTakeFirst();
      if (!clash) return code;
    }
    throw new Error('could not allocate an access code');
  }

  // ---------------------------------------------------------------- lifecycle (booking events, in-transaction)

  deps.events.subscribe('booking.confirmed', async (e, executor) => {
    const plate = await deps.users.plateKeys(e.vehicleId, executor);
    if (!plate) return;
    const w = grantWindow(e.start, e.end);
    const from = new Date(w.from);
    const until = new Date(w.until);
    const code = await freshCode(executor, e.propertyId, from, until);
    const id = uuidv7();
    const inserted = await x(executor)
      .insertInto('access.access_grants')
      .values({
        id,
        booking_id: e.bookingId,
        property_id: e.propertyId,
        asset_id: e.assetId,
        unit_id: e.unitId,
        customer_id: e.customerId,
        vehicle_id: e.vehicleId,
        plate_hmac: plate.hmac,
        plate_last4: plate.last4,
        code_hmac: codeIndex(e.propertyId, code),
        code_enc: cipher.encrypt(code, CODE_CONTEXT),
        valid_from: from,
        valid_until: until,
        status: 'ISSUED',
      })
      .onConflict((oc) => oc.column('booking_id').doNothing()) // a revived booking keeps its grant
      .returning('id')
      .executeTakeFirst();
    if (inserted)
      await logEvent(executor, { propertyId: e.propertyId, grantId: id, kind: 'ISSUED', source: 'SYSTEM' });
  });

  deps.events.subscribe('booking.closed', async (e, executor) => {
    if (e.status === 'COMPLETED') return; // ends by time (EXPIRED)
    const g = await x(executor)
      .selectFrom('access.access_grants')
      .selectAll()
      .where('booking_id', '=', e.bookingId)
      .executeTakeFirst();
    if (!g || g.status === 'REVOKED') return;
    await x(executor)
      .updateTable('access.access_grants')
      .set({
        status: 'REVOKED',
        revoked_reason: `booking ${e.status.toLowerCase()}`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', g.id)
      .execute();
    await logEvent(executor, {
      propertyId: g.property_id,
      grantId: g.id,
      kind: 'REVOKED',
      source: 'SYSTEM',
      detail: e.status,
    });
  });

  // ---------------------------------------------------------------- customer (C-12 "Get in")

  async function grantOf(customerId: string, bookingId: string) {
    const g = await db
      .selectFrom('access.access_grants')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!g) {
      // Hide whether the booking exists for someone else.
      throw accessErrors.notAvailable();
    }
    return g;
  }

  /**
   * Compact signed tokens (URL-safe, < 100 chars): `<fields joined by ~>.<128-bit HMAC>`. Fields are uuids without
   * dashes and a base-36 expiry. Used for the driver pass and the guard's entry ticket.
   */
  const hexId = (uuid: string) => uuid.replaceAll('-', '');
  const uuidOf = (hex: string) =>
    /^[0-9a-f]{32}$/.test(hex)
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : null;
  function sign(purpose: string, fields: string[], exp: number) {
    const payload = [...fields, exp.toString(36)].join('~');
    return `${payload}.${hasher.hash(purpose, payload).subarray(0, 16).toString('base64url')}`;
  }
  function verifySigned(purpose: string, token: string): string[] | null {
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = hasher.hash(purpose, payload).subarray(0, 16);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const parts = payload.split('~');
    const exp = parseInt(parts.at(-1) ?? '', 36);
    if (!Number.isFinite(exp) || exp <= now()) return null;
    return parts.slice(0, -1);
  }
  const passToken = (grantId: string, exp: number) => sign('access.pass', [hexId(grantId)], exp);
  const readPass = (token: string) => {
    const f = verifySigned('access.pass', token);
    const g = f?.[0] ? uuidOf(f[0]) : null;
    return g ? { g } : null;
  };

  async function view(g: Grant) {
    const w = windowOf(g);
    const status = effectiveGrantStatus(g.status as StoredStatus, w, now());
    const [plate, unitLabel] = await Promise.all([plateOf(g), deps.assets.unitLabel(g.unit_id)]);
    return {
      status,
      code: status === 'REVOKED' || status === 'EXPIRED' ? null : cipher.decrypt(g.code_enc, CODE_CONTEXT),
      plate,
      unitLabel,
      validFrom: g.valid_from,
      validUntil: g.valid_until,
      enteredAt: g.first_entry_at,
      canCheckIn: verifies(g.status as StoredStatus, w, now()) && g.status !== 'USED',
      passToken: status === 'REVOKED' || status === 'EXPIRED' ? null : passToken(g.id, w.until),
    };
  }

  async function customerAccess(customerId: string, bookingId: string) {
    const g = await grantOf(customerId, bookingId);
    if (now() >= g.valid_until.getTime() + REVEAL_AFTER_MS) throw accessErrors.notAvailable();
    return view(g);
  }

  async function reissue(customerId: string, bookingId: string, requestId: string) {
    const g = await grantOf(customerId, bookingId);
    if (g.status === 'REVOKED' || now() >= g.valid_until.getTime()) throw accessErrors.notAvailable();
    await db.transaction().execute(async (trx) => {
      const code = await freshCode(trx, g.property_id, g.valid_from, g.valid_until);
      await trx
        .updateTable('access.access_grants')
        .set({
          code_hmac: codeIndex(g.property_id, code),
          code_enc: cipher.encrypt(code, CODE_CONTEXT),
          version: sql<number>`version + 1`,
        })
        .where('id', '=', g.id)
        .execute();
      await logEvent(trx, { propertyId: g.property_id, grantId: g.id, kind: 'REISSUED', source: 'CUSTOMER' });
      await audit.record(
        {
          actorKind: 'USER',
          actorId: customerId,
          action: 'access.code_reissued',
          entityKind: 'booking',
          entityId: bookingId,
          requestId,
        },
        trx,
      );
    });
    return customerAccess(customerId, bookingId);
  }

  /** "I'm here" (C-12): inside the window, marks arrival and moves the booking to IN_PROGRESS. */
  async function checkInByCustomer(customerId: string, bookingId: string, requestId: string) {
    const g = await grantOf(customerId, bookingId);
    if (!verifies(g.status as StoredStatus, windowOf(g), now())) throw accessErrors.outsideWindow();
    await deps.booking.checkIn(bookingId, 'CUSTOMER', requestId);
    await logEvent(undefined, {
      propertyId: g.property_id,
      grantId: g.id,
      kind: 'CHECKED_IN',
      source: 'CUSTOMER',
    });
    return customerAccess(customerId, bookingId);
  }

  /** Digital pass ("share with driver", trust-and-safety §10.1): time-limited, revoked with the booking. */
  async function passView(token: string, ip: string) {
    const data = readPass(token);
    if (!data) throw accessErrors.invalidPass();
    await deps.rateLimiter.enforce({
      key: `access-pass:${createHash('sha256').update(token).digest('hex').slice(0, 24)}`,
      limit: 60,
      windowSeconds: 3600,
    });
    const g = await db
      .selectFrom('access.access_grants')
      .selectAll()
      .where('id', '=', data.g)
      .executeTakeFirst();
    if (!g || g.status === 'REVOKED') throw accessErrors.invalidPass();
    const [access, address] = await Promise.all([
      deps.assets.revealAccess(g.asset_id, g.unit_id),
      deps.properties.exactAddress(g.property_id),
    ]);
    await logEvent(undefined, {
      propertyId: g.property_id,
      grantId: g.id,
      kind: 'PASS_VIEWED',
      source: 'DRIVER_PASS',
      inputHash: hasher.hash('access.ip', ip),
    });
    const v = await view(g);
    return { ...v, passToken: null, address, instructions: access?.accessInstructions ?? null };
  }

  // ---------------------------------------------------------------- guard (G-01)

  async function gateFor(token: string) {
    if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) throw accessErrors.invalidGate();
    const gate = await db
      .selectFrom('access.gate_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHash(token))
      .executeTakeFirst();
    if (!gate || gate.status !== 'ACTIVE' || gate.expires_at.getTime() <= now())
      throw accessErrors.invalidGate();
    return gate;
  }

  async function gateInfo(token: string) {
    const gate = await gateFor(token);
    return { label: gate.label, expiresAt: gate.expires_at };
  }

  /** Full plate, full code or a pass token. No partial search, no listing (trust-and-safety §10.3). */
  async function guardLookup(
    token: string,
    input: { plate?: string | undefined; code?: string | undefined; pass?: string | undefined },
  ) {
    const gate = await gateFor(token);
    await deps.rateLimiter.enforce(
      { key: `gate-lookup:1h:${gate.id}`, limit: 60, windowSeconds: 3600 },
      { key: `gate-lookup:1d:${gate.id}`, limit: 300, windowSeconds: 86_400 },
    );
    let method: AccessMethod;
    let candidates: Grant[];
    let inputHash: Buffer;
    const base = db
      .selectFrom('access.access_grants')
      .selectAll()
      .where('property_id', '=', gate.property_id)
      .where('status', '<>', 'REVOKED');
    if (input.code) {
      method = 'CODE';
      const code = input.code.replace(/\D/g, '');
      inputHash = hasher.hash('access.lookup', `code:${code}`);
      candidates =
        code.length === 6
          ? await base.where('code_hmac', '=', codeIndex(gate.property_id, code)).execute()
          : [];
    } else if (input.plate) {
      method = 'VEHICLE_NUMBER';
      const idx = deps.users.plateIndex(input.plate);
      inputHash = hasher.hash('access.lookup', `plate:${normalizePlate(input.plate) ?? input.plate}`);
      candidates = idx ? await base.where('plate_hmac', '=', idx).execute() : [];
    } else {
      method = 'PASS';
      inputHash = hasher.hash('access.lookup', `pass:${input.pass ?? ''}`);
      const data = input.pass ? readPass(input.pass) : null;
      candidates = data ? await base.where('id', '=', data.g).execute() : [];
    }
    const t = now();
    const valid = candidates.find((g) => verifies(g.status as StoredStatus, windowOf(g), t));
    await logEvent(undefined, {
      propertyId: gate.property_id,
      grantId: valid?.id ?? null,
      gateId: gate.id,
      kind: valid ? 'VERIFIED' : 'DENIED',
      source: 'GUARD',
      method,
      inputHash,
      detail: valid ? null : candidates.length ? 'outside window' : 'no booking',
    });
    if (!valid) return { valid: false as const, reason: 'NO_BOOKING_NOW' as const };
    const vehicle = await plateOf(valid);
    const ticket = sign('access.entry', [hexId(valid.id), hexId(gate.id)], t + ENTRY_TICKET_MINUTES * 60_000);
    return {
      valid: true as const,
      unitLabel: await deps.assets.unitLabel(valid.unit_id),
      validUntil: valid.valid_until,
      // The guard compares the plate on the car: a code alone never admits a different vehicle (§10.1).
      expectedPlate: vehicle,
      alreadyEntered: valid.status === 'USED',
      entryTicket: ticket,
    };
  }

  /** The plate lives with the vehicle (users module, encrypted); grants keep only its blind index and last 4. */
  async function plateOf(g: Grant): Promise<string> {
    const v = await deps.users.vehicleById(g.vehicle_id);
    return v ? formatPlate(v.plate) : `•••• ${g.plate_last4}`;
  }

  /** "Allow entry": records ENTERED and checks the booking in. */
  async function guardEntry(token: string, ticket: string, requestId: string) {
    const gate = await gateFor(token);
    const fields = verifySigned('access.entry', ticket);
    const data = fields ? { g: uuidOf(fields[0] ?? '') ?? '', gate: uuidOf(fields[1] ?? '') } : null;
    if (!data || data.gate !== gate.id) throw accessErrors.invalidTicket();
    const g = await db
      .selectFrom('access.access_grants')
      .selectAll()
      .where('id', '=', data.g)
      .where('property_id', '=', gate.property_id)
      .executeTakeFirst();
    if (!g || !verifies(g.status as StoredStatus, windowOf(g), now())) throw accessErrors.invalidTicket();
    await recordEntry(g, { gateId: gate.id, source: 'GUARD', method: null }, requestId);
    return { entered: true };
  }

  async function recordEntry(
    g: Grant,
    how: { gateId: string | null; source: string; method: string | null },
    requestId: string,
  ) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('access.access_grants')
        .set({
          status: 'USED',
          first_entry_at: sql<Date>`coalesce(first_entry_at, now())`,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', g.id)
        .where('status', '<>', 'REVOKED')
        .execute();
      await logEvent(trx, {
        propertyId: g.property_id,
        grantId: g.id,
        gateId: how.gateId,
        kind: 'ENTERED',
        source: how.source,
        method: how.method,
      });
    });
    await deps.booking.checkIn(g.booking_id, how.source === 'GUARD' ? 'GUARD' : 'ADAPTER', requestId);
  }

  /** External systems (ANPR read, smart lock opened): verified against live grants by plate, then ENTERED. */
  async function ingestExternal(e: ExternalAccessEvent, requestId: string) {
    const idx = e.plate ? deps.users.plateIndex(e.plate) : null;
    const candidates = idx
      ? await db
          .selectFrom('access.access_grants')
          .selectAll()
          .where('property_id', '=', e.propertyId)
          .where('plate_hmac', '=', idx)
          .where('status', '<>', 'REVOKED')
          .execute()
      : [];
    const valid = candidates.find((g) => verifies(g.status as StoredStatus, windowOf(g), e.at));
    if (!valid) {
      await logEvent(undefined, {
        propertyId: e.propertyId,
        kind: 'DENIED',
        source: 'ADAPTER',
        method: e.kind,
        inputHash: e.plate
          ? hasher.hash('access.lookup', `plate:${normalizePlate(e.plate) ?? e.plate}`)
          : null,
        detail: 'no booking',
      });
      return { admitted: false };
    }
    await recordEntry(valid, { gateId: null, source: 'ADAPTER', method: e.kind }, requestId);
    return { admitted: true };
  }

  // ---------------------------------------------------------------- property owner: gates and access log

  async function ownedProperty(host: Host, propertyId: string) {
    const p = await deps.properties.hostRelation(propertyId, host.hostAccountId); // 404 if not theirs
    if (p.relation !== 'OWNER') throw accessErrors.ownerOnly();
    return p;
  }

  async function createGate(actor: { userId: string }, propertyId: string, label: string, requestId: string) {
    const token = randomBytes(24).toString('base64url'); // 192-bit
    const id = uuidv7();
    const expiresAt = new Date(now() + GATE_TOKEN_DAYS * 86_400_000);
    await db
      .insertInto('access.gate_tokens')
      .values({
        id,
        property_id: propertyId,
        label,
        token_hash: tokenHash(token),
        expires_at: expiresAt,
        created_by: actor.userId,
      })
      .execute();
    await audit.record({
      actorKind: 'USER',
      actorId: actor.userId,
      action: 'access.gate_created',
      entityKind: 'property',
      entityId: propertyId,
      metadata: { gateId: id, label },
      requestId,
    });
    return { id, label, token, path: `/gate/${token}`, expiresAt };
  }

  async function listGates(propertyId: string) {
    const rows = await db
      .selectFrom('access.gate_tokens')
      .select(['id', 'label', 'status', 'expires_at', 'created_at'])
      .where('property_id', '=', propertyId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status as 'ACTIVE' | 'REVOKED',
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  }

  async function revokeGate(
    actor: { userId: string },
    propertyId: string,
    gateId: string,
    requestId: string,
  ) {
    const res = await db
      .updateTable('access.gate_tokens')
      .set({ status: 'REVOKED' })
      .where('id', '=', gateId)
      .where('property_id', '=', propertyId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw errors.notFound();
    await audit.record({
      actorKind: 'USER',
      actorId: actor.userId,
      action: 'access.gate_revoked',
      entityKind: 'property',
      entityId: propertyId,
      metadata: { gateId },
      requestId,
    });
  }

  async function accessLog(propertyId: string) {
    const rows = await db
      .selectFrom('access.access_events as e')
      .leftJoin('access.access_grants as g', 'g.id', 'e.grant_id')
      .leftJoin('access.gate_tokens as t', 't.id', 'e.gate_id')
      .select([
        'e.id',
        'e.kind',
        'e.source',
        'e.method',
        'e.detail',
        'e.created_at',
        'g.plate_last4',
        't.label as gate_label',
        'g.unit_id',
      ])
      .where('e.property_id', '=', propertyId)
      .orderBy('e.id', 'desc')
      .limit(200)
      .execute();
    return Promise.all(
      rows.map(async (r) => ({
        kind: r.kind,
        source: r.source,
        method: r.method,
        detail: r.detail,
        gate: r.gate_label,
        plateLast4: r.plate_last4,
        unitLabel: r.unit_id ? await deps.assets.unitLabel(r.unit_id) : null,
        at: r.created_at,
      })),
    );
  }

  /** Access events of one booking (dispute evidence, admin only). */
  async function bookingAccessLog(bookingId: string) {
    const rows = await db
      .selectFrom('access.access_events as e')
      .innerJoin('access.access_grants as g', 'g.id', 'e.grant_id')
      .leftJoin('access.gate_tokens as t', 't.id', 'e.gate_id')
      .select(['e.kind', 'e.source', 'e.method', 'e.detail', 'e.created_at', 't.label as gate'])
      .where('g.booking_id', '=', bookingId)
      .orderBy('e.id')
      .execute();
    return rows.map((r) => ({
      kind: r.kind,
      source: r.source,
      method: r.method,
      detail: r.detail,
      gate: r.gate,
      at: r.created_at,
    }));
  }

  return {
    customerAccess,
    bookingAccessLog,
    reissue,
    checkInByCustomer,
    passView,
    gateInfo,
    guardLookup,
    guardEntry,
    ingestExternal,
    hostGates: {
      create: async (host: Host, propertyId: string, label: string, requestId: string) => {
        await ownedProperty(host, propertyId);
        return createGate(host, propertyId, label, requestId);
      },
      list: async (host: Host, propertyId: string) => (
        await ownedProperty(host, propertyId),
        listGates(propertyId)
      ),
      revoke: async (host: Host, propertyId: string, gateId: string, requestId: string) => {
        await ownedProperty(host, propertyId);
        await revokeGate(host, propertyId, gateId, requestId);
      },
      log: async (host: Host, propertyId: string) => (
        await ownedProperty(host, propertyId),
        accessLog(propertyId)
      ),
    },
    adminGates: { create: createGate, list: listGates, revoke: revokeGate, log: accessLog },
  };
}

export type AccessService = ReturnType<typeof createAccessService>;
