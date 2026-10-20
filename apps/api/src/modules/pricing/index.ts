import { sql, type ColumnType, type Kysely } from 'kysely';
import type { AnyKyselyExecutor } from '../../platform/audit/audit-log.ts';
import { uuidv7 } from '../../platform/ids/uuid.ts';

/**
 * Pricing (Phase 9 minimal foundation: host-set rates per booking mode). Quotes, fees, commission and refunds
 * arrive with booking (Phase 12) and payments (Phase 15). Old rates are retired, never edited, so history is kept
 * and existing bookings keep their snapshot price (BR-17, BR-23).
 */
export const BOOKING_MODES = ['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION'] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];
export const PRICING_UNITS = ['PER_HOUR', 'PER_DAY', 'PER_NIGHT', 'PER_MONTH', 'PER_SESSION'] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

export const UNITS_FOR_MODE: Record<BookingMode, readonly PricingUnit[]> = {
  HOURLY: ['PER_HOUR'],
  DAILY: ['PER_DAY'],
  OVERNIGHT: ['PER_NIGHT'],
  MONTHLY: ['PER_MONTH'],
  CHARGING_SESSION: ['PER_HOUR', 'PER_SESSION'],
};

export interface RateInput {
  mode: BookingMode;
  unit: PricingUnit;
  pricePaise: number;
  overnightStart?: string | null | undefined;
  overnightEnd?: string | null | undefined;
}

interface RatesTable {
  id: string;
  asset_id: string;
  mode: string;
  unit: string;
  price_paise: ColumnType<string, number, number>; // int8 → string from pg
  overnight_start: string | null;
  overnight_end: string | null;
  effective_from: ColumnType<Date, Date | string | undefined, never>;
  retired_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}
interface QuotesTable {
  id: string;
  customer_id: string;
  asset_id: string;
  mode: string;
  period: unknown;
  lines: unknown;
  total_paise: ColumnType<string, number, number>;
  config_version: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  used_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}
type PricingDb = { 'pricing.rates': RatesTable; 'pricing.quotes': QuotesTable };

export interface StoredQuote {
  id: string;
  customerId: string;
  assetId: string;
  mode: BookingMode;
  start: number;
  end: number;
  snapshot: Record<string, unknown>; // lines, totals, config version, commission bps
  totalPaise: number;
  expiresAt: Date;
  expired: boolean;
  used: boolean;
}

export const QUOTE_TTL_MINUTES = 15;

export interface PricingModule {
  /** Replaces the asset's current rates with `rates` (atomic with the caller's transaction when given). */
  replaceRates(assetId: string, rates: RateInput[], executor?: AnyKyselyExecutor): Promise<void>;
  currentRates(assetId: string): Promise<(RateInput & { effectiveFrom: Date })[]>;
  saveQuote(input: {
    customerId: string;
    assetId: string;
    mode: BookingMode;
    start: number;
    end: number;
    snapshot: Record<string, unknown>;
    totalPaise: number;
    configVersion: string;
  }): Promise<StoredQuote>;
  /** Reads (and, with an executor, row-locks) a quote for use in a booking transaction. */
  lockQuote(quoteId: string, executor?: AnyKyselyExecutor): Promise<StoredQuote | null>;
  markQuoteUsed(quoteId: string, executor: AnyKyselyExecutor): Promise<void>;
  purgeOldQuotes(): Promise<number>;
}

export {
  PRICING_CONFIG,
  bps,
  computeQuote,
  type Quote,
  type QuoteError,
  type QuoteLine,
  type RateForQuote,
} from './domain/quote.ts';

export function createPricingModule<DB>(deps: { db: Kysely<DB> }): PricingModule {
  const db = deps.db.withTables<PricingDb>() as unknown as Kysely<PricingDb>;
  const api: PricingModule = {
    async replaceRates(assetId, rates, executor) {
      const run = async (trx: Kysely<PricingDb>) => {
        await trx
          .updateTable('pricing.rates')
          .set({ retired_at: sql<Date>`now()` })
          .where('asset_id', '=', assetId)
          .where('retired_at', 'is', null)
          .execute();
        if (rates.length === 0) return;
        await trx
          .insertInto('pricing.rates')
          .values(
            rates.map((r) => ({
              id: uuidv7(),
              asset_id: assetId,
              mode: r.mode,
              unit: r.unit,
              price_paise: r.pricePaise,
              overnight_start: r.overnightStart ?? null,
              overnight_end: r.overnightEnd ?? null,
            })),
          )
          .execute();
      };
      if (executor) await run(executor as unknown as Kysely<PricingDb>);
      else await db.transaction().execute(run);
    },
    async saveQuote(input) {
      const id = uuidv7();
      await db
        .insertInto('pricing.quotes')
        .values({
          id,
          customer_id: input.customerId,
          asset_id: input.assetId,
          mode: input.mode,
          period: sql`tstzrange(to_timestamp(${input.start / 1000}), to_timestamp(${input.end / 1000}), '[)')`,
          lines: JSON.stringify(input.snapshot),
          total_paise: input.totalPaise,
          config_version: input.configVersion,
          expires_at: sql<Date>`now() + make_interval(mins => ${QUOTE_TTL_MINUTES})`,
        })
        .execute();
      return (await api.lockQuote(id)) as StoredQuote;
    },
    async lockQuote(quoteId, executor) {
      let q = ((executor as unknown as Kysely<PricingDb> | undefined) ?? db)
        .selectFrom('pricing.quotes')
        .select([
          'id',
          'customer_id',
          'asset_id',
          'mode',
          'lines',
          'total_paise',
          'expires_at',
          'used_at',
          sql<number>`extract(epoch FROM lower(period)) * 1000`.as('start_ms'),
          sql<number>`extract(epoch FROM upper(period)) * 1000`.as('end_ms'),
          sql<boolean>`expires_at <= now()`.as('expired'),
        ])
        .where('id', '=', quoteId);
      if (executor) q = q.forUpdate();
      const row = await q.executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        customerId: row.customer_id,
        assetId: row.asset_id,
        mode: row.mode as BookingMode,
        start: Number(row.start_ms),
        end: Number(row.end_ms),
        snapshot: row.lines as Record<string, unknown>,
        totalPaise: Number(row.total_paise),
        expiresAt: row.expires_at,
        expired: row.expired,
        used: row.used_at !== null,
      };
    },
    async markQuoteUsed(quoteId, executor) {
      await (executor as unknown as Kysely<PricingDb>)
        .updateTable('pricing.quotes')
        .set({ used_at: sql<Date>`now()` })
        .where('id', '=', quoteId)
        .execute();
    },
    async purgeOldQuotes() {
      // Unused quotes older than a day; used ones are referenced by bookings and kept.
      const result = await db
        .deleteFrom('pricing.quotes')
        .where('used_at', 'is', null)
        .where(sql<boolean>`expires_at < now() - interval '1 day'`)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    async currentRates(assetId) {
      const rows = await db
        .selectFrom('pricing.rates')
        .select(['mode', 'unit', 'price_paise', 'overnight_start', 'overnight_end', 'effective_from'])
        .where('asset_id', '=', assetId)
        .where('retired_at', 'is', null)
        .orderBy('mode')
        .execute();
      return rows.map((r) => ({
        mode: r.mode as BookingMode,
        unit: r.unit as PricingUnit,
        pricePaise: Number(r.price_paise),
        overnightStart: r.overnight_start?.slice(0, 5) ?? null,
        overnightEnd: r.overnight_end?.slice(0, 5) ?? null,
        effectiveFrom: r.effective_from,
      }));
    },
  };
  return api;
}
