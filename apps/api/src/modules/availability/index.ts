import type { ColumnType, Kysely } from 'kysely';
import type { AnyKyselyExecutor } from '../../platform/audit/audit-log.ts';
import { sql } from 'kysely';
import { uuidv7 } from '../../platform/ids/uuid.ts';
import type { AvailabilityException, Reservation } from './domain/engine.ts';

export { expandRules, merge, rulesCover, type Interval, type WeeklyRule } from './domain/coverage.ts';
export {
  assetCheck,
  availableUnits,
  checkUnit,
  freeTime,
  maxConcurrent,
  type AssetAvailabilityInput,
  type AvailabilityException,
  type Reservation,
  type UnavailableReason,
} from './domain/engine.ts';

/**
 * Holding reservations (bookings that occupy a unit, domain-model §5.3) as seen by the availability engine.
 * Implemented by the booking module in Phase 12; until bookings exist nothing is reserved. Implementations must
 * honour `executor` so checks run inside the caller's transaction (block vs booking, BR-04).
 */
export interface ReservationSource {
  holdingReservations(
    unitIds: readonly string[],
    from: number,
    to: number,
    executor?: AnyKyselyExecutor,
  ): Promise<Reservation[]>;
}

export const noReservations: ReservationSource = {
  holdingReservations: async () => [],
};

/**
 * Availability (Phase 9 minimal foundation: weekly rule storage + validation, needed by publish preconditions).
 * The availability engine (expansion in the asset's timezone, exceptions, blocks, booking-based unavailability,
 * BR-01 to BR-06) is Phase 11. Times are local wall-clock in the property's timezone.
 */
export const MAX_RULES_PER_ASSET = 14;

export interface AvailabilityRuleInput {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  /** "HH:MM" local. end <= start means the window crosses midnight; equal means the full day. */
  startLocal: string;
  endLocal: string;
  validFrom?: string | undefined; // YYYY-MM-DD
  validTo?: string | null | undefined;
}

interface RulesTable {
  id: string;
  asset_id: string;
  weekdays: number[];
  start_local: string;
  end_local: string;
  valid_from: ColumnType<string, string | undefined, string>;
  valid_to: string | null;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}
interface ExceptionsTable {
  id: string;
  asset_id: string;
  unit_id: string | null;
  kind: string;
  period: unknown; // tstzrange, written/read through SQL
  reason: string | null;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}
type AvailabilityDb = {
  'availability.availability_rules': RulesTable;
  'availability.availability_exceptions': ExceptionsTable;
};

export interface ExceptionInput {
  assetId: string;
  unitId: string | null;
  kind: 'BLOCK' | 'OPEN';
  start: number;
  end: number;
  reason: string | null;
  createdBy: string;
}

export type StoredException = AvailabilityException & { reason: string | null; createdAt: Date };

export interface AvailabilityModule {
  replaceRules(assetId: string, rules: AvailabilityRuleInput[], executor?: AnyKyselyExecutor): Promise<void>;
  listRules(
    assetId: string,
    executor?: AnyKyselyExecutor,
  ): Promise<(AvailabilityRuleInput & { id: string })[]>;
  addException(input: ExceptionInput, executor?: AnyKyselyExecutor): Promise<string>;
  removeException(assetId: string, exceptionId: string, executor?: AnyKyselyExecutor): Promise<boolean>;
  /** Exceptions overlapping [from, to) (all of them when no range is given). */
  listExceptions(
    assetId: string,
    range?: { from: number; to: number },
    executor?: AnyKyselyExecutor,
  ): Promise<StoredException[]>;
}

export function createAvailabilityModule<DB>(deps: { db: Kysely<DB> }): AvailabilityModule {
  const db = deps.db.withTables<AvailabilityDb>() as unknown as Kysely<AvailabilityDb>;
  return {
    async replaceRules(assetId, rules, executor) {
      const run = async (trx: Kysely<AvailabilityDb>) => {
        await trx.deleteFrom('availability.availability_rules').where('asset_id', '=', assetId).execute();
        if (rules.length === 0) return;
        await trx
          .insertInto('availability.availability_rules')
          .values(
            rules.map((r) => ({
              id: uuidv7(),
              asset_id: assetId,
              weekdays: [...new Set(r.weekdays)].sort(),
              start_local: r.startLocal,
              end_local: r.endLocal,
              ...(r.validFrom ? { valid_from: r.validFrom } : {}),
              valid_to: r.validTo ?? null,
            })),
          )
          .execute();
      };
      if (executor) await run(executor as unknown as Kysely<AvailabilityDb>);
      else await db.transaction().execute(run);
    },
    async addException(input, executor) {
      const id = uuidv7();
      await ((executor as unknown as Kysely<AvailabilityDb> | undefined) ?? db)
        .insertInto('availability.availability_exceptions')
        .values({
          id,
          asset_id: input.assetId,
          unit_id: input.unitId,
          kind: input.kind,
          period: sql`tstzrange(to_timestamp(${input.start / 1000}), to_timestamp(${input.end / 1000}), '[)')`,
          reason: input.reason,
          created_by: input.createdBy,
        })
        .execute();
      return id;
    },
    async removeException(assetId, exceptionId, executor) {
      const result = await ((executor as unknown as Kysely<AvailabilityDb> | undefined) ?? db)
        .deleteFrom('availability.availability_exceptions')
        .where('id', '=', exceptionId)
        .where('asset_id', '=', assetId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async listExceptions(assetId, range, executor) {
      let q = ((executor as unknown as Kysely<AvailabilityDb> | undefined) ?? db)
        .selectFrom('availability.availability_exceptions')
        .select([
          'id',
          'unit_id',
          'kind',
          'reason',
          'created_at',
          sql<number>`extract(epoch FROM lower(period)) * 1000`.as('start_ms'),
          sql<number>`extract(epoch FROM upper(period)) * 1000`.as('end_ms'),
        ])
        .where('asset_id', '=', assetId);
      if (range) {
        q = q.where(
          sql<boolean>`period && tstzrange(to_timestamp(${range.from / 1000}), to_timestamp(${range.to / 1000}), '[)')`,
        );
      }
      const rows = await q.orderBy(sql`lower(period)`).execute();
      return rows.map((r) => ({
        id: r.id,
        unitId: r.unit_id,
        kind: r.kind as 'BLOCK' | 'OPEN',
        start: Number(r.start_ms),
        end: Number(r.end_ms),
        reason: r.reason,
        createdAt: r.created_at,
      }));
    },
    async listRules(assetId, executor) {
      const rows = await ((executor as unknown as Kysely<AvailabilityDb> | undefined) ?? db)
        .selectFrom('availability.availability_rules')
        .select(['id', 'weekdays', 'start_local', 'end_local', 'valid_from', 'valid_to'])
        .where('asset_id', '=', assetId)
        .orderBy('created_at')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        weekdays: r.weekdays,
        startLocal: r.start_local.slice(0, 5),
        endLocal: r.end_local.slice(0, 5),
        validFrom: String(r.valid_from),
        validTo: r.valid_to === null ? null : String(r.valid_to),
      }));
    },
  };
}
