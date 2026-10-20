import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ColumnType, Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { AnyKyselyExecutor, AuditLog } from '../../platform/audit/audit-log.ts';
import { actorOf, requireUser } from '../../platform/auth/authentication.ts';
import type { FieldCipher } from '../../platform/crypto/field-cipher.ts';
import type { KeyedHasher } from '../../platform/crypto/keyed-hash.ts';
import { DomainError, errors } from '../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../platform/ids/uuid.ts';
import { dataRequestAdminRoutes, dataRequestRoutes } from './data-requests.ts';
import { formatPlate, normalizePlate } from './domain/plate.ts';

export { formatPlate, normalizePlate } from './domain/plate.ts';

/** Vehicles (domain-model §3.1; trust-and-safety V-VEHICLE-FMT). Plates are personal data: encrypted at rest. */
export const VEHICLE_CLASSES = ['HATCHBACK', 'SEDAN', 'SUV', 'MUV'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];
export const CONNECTORS = ['TYPE2', 'CCS2', 'BHARAT_AC001', 'BHARAT_DC001', 'IEC_15A', 'GBT'] as const;
const MAX_VEHICLES = 5;
const PLATE_CONTEXT = 'users.vehicles.plate';
const PLATE_INDEX = 'users.vehicle_plate';

interface VehiclesTable {
  id: string;
  owner_id: string;
  plate_enc: Buffer;
  plate_hmac: Buffer;
  plate_last4: string;
  vehicle_class: string;
  is_ev: boolean;
  connectors: string[];
  nickname: string | null;
  status: ColumnType<string, string | undefined, string>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}
type UsersDb = { 'users.vehicles': VehiclesTable };

export interface OwnedVehicle {
  id: string;
  vehicleClass: VehicleClass;
  isEv: boolean;
  connectors: string[];
  plate: string; // normalised
  nickname: string | null;
}

export interface UsersModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** The customer's own active vehicle, or null. */
  ownedVehicle(userId: string, vehicleId: string): Promise<OwnedVehicle | null>;
  /** Plate and class of a vehicle (booking parties only; callers enforce visibility, trust-and-safety §11). */
  vehicleById(vehicleId: string): Promise<OwnedVehicle | null>;
  /** Blind index and last 4 of a vehicle's plate (access grants), on the caller's transaction when given. */
  plateKeys(vehicleId: string, executor?: AnyKyselyExecutor): Promise<{ hmac: Buffer; last4: string } | null>;
  /** Blind index for a plate typed at a gate; null if it isn't a valid plate. */
  plateIndex(rawPlate: string): Buffer | null;
}

const vehicleView = z.object({
  id: z.uuid(),
  plate: z.string(),
  vehicleClass: z.enum(VEHICLE_CLASSES),
  isEv: z.boolean(),
  connectors: z.array(z.string()),
  nickname: z.string().nullable(),
});

export function createUsersModule<DB>(deps: {
  db: Kysely<DB>;
  cipher: FieldCipher;
  hasher: KeyedHasher;
  audit: AuditLog;
  now?: () => number;
}): UsersModule {
  const db = deps.db.withTables<UsersDb>() as unknown as Kysely<UsersDb>;
  const toVehicle = (row: Selectable<VehiclesTable>): OwnedVehicle => ({
    id: row.id,
    vehicleClass: row.vehicle_class as VehicleClass,
    isEv: row.is_ev,
    connectors: row.connectors,
    plate: deps.cipher.decrypt(row.plate_enc, PLATE_CONTEXT),
    nickname: row.nickname,
  });
  const view = (v: OwnedVehicle) => ({
    id: v.id,
    plate: formatPlate(v.plate),
    vehicleClass: v.vehicleClass,
    isEv: v.isEv,
    connectors: v.connectors,
    nickname: v.nickname,
  });

  const routes: FastifyPluginAsync = async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/v1/me/vehicles',
      { preHandler: requireUser, schema: { tags: ['me'], response: { 200: z.array(vehicleView) } } },
      async (request) => {
        const rows = await db
          .selectFrom('users.vehicles')
          .selectAll()
          .where('owner_id', '=', actorOf(request).userId)
          .where('status', '=', 'ACTIVE')
          .orderBy('created_at')
          .execute();
        return rows.map((row) => view(toVehicle(row)));
      },
    );

    r.post(
      '/v1/me/vehicles',
      {
        preHandler: requireUser,
        schema: {
          tags: ['me'],
          body: z
            .object({
              plate: z.string().max(20),
              vehicleClass: z.enum(VEHICLE_CLASSES),
              isEv: z.boolean().default(false),
              connectors: z.array(z.enum(CONNECTORS)).max(6).default([]),
              nickname: z.string().trim().max(30).nullable().default(null),
            })
            .refine((v) => v.isEv || v.connectors.length === 0, 'Only EVs have charging connectors')
            .refine((v) => !v.isEv || v.connectors.length > 0, 'Choose at least one connector for an EV'),
          response: { 201: vehicleView },
        },
      },
      async (request, reply) => {
        const userId = actorOf(request).userId;
        const plate = normalizePlate(request.body.plate);
        if (!plate) {
          throw new DomainError({
            code: 'vehicle.plate_invalid',
            status: 400,
            title: 'Enter a valid registration number',
            detail: 'For example KA 01 AB 1234.',
          });
        }
        const count = await db
          .selectFrom('users.vehicles')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .where('owner_id', '=', userId)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= MAX_VEHICLES) {
          throw new DomainError({
            code: 'vehicle.limit_reached',
            status: 409,
            title: `You can add up to ${MAX_VEHICLES} vehicles`,
          });
        }
        const id = uuidv7();
        try {
          await db
            .insertInto('users.vehicles')
            .values({
              id,
              owner_id: userId,
              plate_enc: deps.cipher.encrypt(plate, PLATE_CONTEXT),
              plate_hmac: deps.hasher.hash(PLATE_INDEX, plate),
              plate_last4: plate.slice(-4),
              vehicle_class: request.body.vehicleClass,
              is_ev: request.body.isEv,
              connectors: [...new Set(request.body.connectors)],
              nickname: request.body.nickname,
            })
            .execute();
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            // Same plate active on another account (trust-and-safety §5 shared-plate signal): support resolves it.
            throw new DomainError({
              code: 'vehicle.plate_in_use',
              status: 409,
              title: 'This vehicle is already registered',
              detail: 'If it is yours, contact support and we will sort it out.',
            });
          }
          throw error;
        }
        await deps.audit.record({
          actorKind: 'USER',
          actorId: userId,
          action: 'vehicle.added',
          entityKind: 'vehicle',
          entityId: id,
          requestId: request.id,
        });
        return reply.status(201).send(
          view({
            id,
            plate,
            vehicleClass: request.body.vehicleClass,
            isEv: request.body.isEv,
            connectors: request.body.connectors,
            nickname: request.body.nickname,
          }),
        );
      },
    );

    r.delete(
      '/v1/me/vehicles/:vehicleId',
      { preHandler: requireUser, schema: { tags: ['me'], params: z.object({ vehicleId: z.uuid() }) } },
      async (request, reply) => {
        const result = await db
          .updateTable('users.vehicles')
          .set({ status: 'REMOVED' })
          .where('id', '=', request.params.vehicleId)
          .where('owner_id', '=', actorOf(request).userId)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) === 0) throw errors.notFound();
        return reply.status(204).send();
      },
    );
  };

  return {
    registerRoutes: async (api) => {
      const requests = { db: deps.db as never, audit: deps.audit, now: deps.now ?? Date.now };
      await api.register(routes);
      await api.register(dataRequestRoutes, requests);
      await api.register(dataRequestAdminRoutes, { prefix: '/admin', ...requests });
    },
    async ownedVehicle(userId, vehicleId) {
      const row = await db
        .selectFrom('users.vehicles')
        .selectAll()
        .where('id', '=', vehicleId)
        .where('owner_id', '=', userId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();
      return row ? toVehicle(row) : null;
    },
    async plateKeys(vehicleId, executor) {
      const row = await ((executor as unknown as Kysely<UsersDb> | undefined) ?? db)
        .selectFrom('users.vehicles')
        .select(['plate_hmac', 'plate_last4'])
        .where('id', '=', vehicleId)
        .executeTakeFirst();
      return row ? { hmac: row.plate_hmac, last4: row.plate_last4 } : null;
    },
    plateIndex(rawPlate) {
      const plate = normalizePlate(rawPlate);
      return plate ? deps.hasher.hash(PLATE_INDEX, plate) : null;
    },
    async vehicleById(vehicleId) {
      const row = await db
        .selectFrom('users.vehicles')
        .selectAll()
        .where('id', '=', vehicleId)
        .executeTakeFirst();
      return row ? toVehicle(row) : null;
    },
  };
}
