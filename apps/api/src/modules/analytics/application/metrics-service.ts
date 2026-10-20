import { sql, type Kysely } from 'kysely';
import type { AnyKyselyExecutor } from '../../../platform/audit/audit-log.ts';
import type { DomainEventMap } from '../../../platform/events/domain-events.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Search and view events are kept long enough for year-on-year comparison, then purged (D-161). */
export const EVENT_RETENTION_DAYS = 400;
/** Bookings that occupied the unit: a no-show still blocked it (BR-08). */
const OCCUPYING = sql`('CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW')`;

type AssetType = 'PARKING' | 'EV_CHARGING';
type Window = { start: Date; end: Date; days: number };

const n = (v: string | number | null | undefined) => Number(v ?? 0);
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('aggregate query returned no row');
  return row;
}
const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null);

/**
 * Marketplace analytics (Phase 21, docs/analytics.md). A read-only reporting model: it reads the systems of record
 * across schemas (bookings, ledger, assets, identity) and never writes to them; the only rows it owns are the
 * anonymous discovery signals in analytics.* (D-159, D-160). Money comes from the double-entry ledger, so these
 * numbers reconcile with Finance's trial balance.
 */
export function createMetricsService(deps: { db: Kysely<unknown>; now?: () => number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const minute = () => new Date(Math.floor(now() / 60_000) * 60_000);

  function windowOf(days: number): Window {
    const end = new Date(now());
    return { start: new Date(end.getTime() - days * DAY), end, days };
  }

  /** Confirmation time of each booking: the moment it became a real booking (paid, or approved and paid). */
  const confirmed = sql`(SELECT booking_id, min(created_at) AS at FROM booking.booking_events
      WHERE to_status = 'CONFIRMED' GROUP BY booking_id)`;

  async function supply(w: Window) {
    const hosts = await sql<{ total: string; created: string; live: string; booked: string }>`
      SELECT
        (SELECT count(*) FROM identity.host_accounts) AS total,
        (SELECT count(*) FROM identity.host_accounts WHERE created_at >= ${w.start} AND created_at < ${w.end}) AS created,
        (SELECT count(DISTINCT a.host_account_id) FROM assets.assets a
           JOIN identity.host_accounts h ON h.id = a.host_account_id
          WHERE a.status = 'PUBLISHED' AND h.status = 'ACTIVE') AS live,
        (SELECT count(DISTINCT b.host_account_id) FROM booking.bookings b JOIN ${confirmed} c ON c.booking_id = b.id
          WHERE c.at >= ${w.start} AND c.at < ${w.end}) AS booked`.execute(db);

    // Open unit-hours come from the weekly rules (capped at 168 h a week per listing); exceptions are ignored, so
    // this is the advertised capacity, not a minute-exact one (docs/analytics.md §3).
    const inventory = await sql<{
      asset_type: AssetType;
      listings: string;
      units: string;
      open_unit_hours: string;
      booked_unit_hours: string;
    }>`
      WITH weekly AS (
        SELECT r.asset_id, least(168, sum(cardinality(r.weekdays) * CASE
            WHEN r.end_local > r.start_local THEN extract(epoch FROM r.end_local - r.start_local)
            ELSE 86400 - extract(epoch FROM r.start_local - r.end_local) END) / 3600.0) AS hours
          FROM availability.availability_rules r
         WHERE r.valid_from <= ${w.end}::date AND (r.valid_to IS NULL OR r.valid_to >= ${w.start}::date)
         GROUP BY r.asset_id),
      live AS (
        SELECT a.id, a.asset_type, coalesce(wk.hours, 0) AS hours,
               (SELECT count(*) FROM assets.asset_units u WHERE u.asset_id = a.id AND u.status = 'ACTIVE') AS units
          FROM assets.assets a LEFT JOIN weekly wk ON wk.asset_id = a.id
         WHERE a.status = 'PUBLISHED'),
      booked AS (
        SELECT b.asset_type, sum(extract(epoch FROM
                 upper(b.period * tstzrange(${w.start}, ${w.end})) - lower(b.period * tstzrange(${w.start}, ${w.end})))
               ) / 3600.0 AS hours
          FROM booking.bookings b
         WHERE b.status IN ${OCCUPYING} AND b.period && tstzrange(${w.start}, ${w.end})
         GROUP BY b.asset_type),
      types AS (SELECT code AS asset_type FROM assets.asset_types)
      SELECT t.asset_type,
             (SELECT count(*) FROM live l WHERE l.asset_type = t.asset_type) AS listings,
             (SELECT coalesce(sum(l.units), 0) FROM live l WHERE l.asset_type = t.asset_type) AS units,
             (SELECT coalesce(sum(l.units * l.hours), 0) * ${w.days} / 7.0 FROM live l WHERE l.asset_type = t.asset_type)
               AS open_unit_hours,
             coalesce((SELECT bk.hours FROM booked bk WHERE bk.asset_type = t.asset_type), 0) AS booked_unit_hours
        FROM types t ORDER BY t.asset_type`.execute(db);

    const h = first(hosts.rows);
    const byType = inventory.rows.map((r) => {
      const open = Math.round(n(r.open_unit_hours) * 10) / 10;
      const booked = Math.round(n(r.booked_unit_hours) * 10) / 10;
      return {
        assetType: r.asset_type,
        publishedListings: n(r.listings),
        activeUnits: n(r.units),
        openUnitHours: open,
        bookedUnitHours: booked,
        utilisation: ratio(booked, open),
      };
    });
    const open = byType.reduce((s, t) => s + t.openUnitHours, 0);
    const booked = byType.reduce((s, t) => s + t.bookedUnitHours, 0);
    return {
      hosts: { total: n(h.total), new: n(h.created), live: n(h.live), withBookings: n(h.booked) },
      byType,
      utilisation: ratio(booked, open),
    };
  }

  async function demand(w: Window) {
    const r = first(
      (
        await sql<{
          customers: string;
          customers_new: string;
          searches: string;
          zero: string;
          windowed: string;
          views: string;
          requested: string;
          requested_confirmed: string;
          confirmed: string;
          booking_customers: string;
          repeat_customers: string;
        }>`
      WITH c AS (SELECT b.id, b.customer_id FROM booking.bookings b JOIN ${confirmed} c ON c.booking_id = b.id
                  WHERE c.at >= ${w.start} AND c.at < ${w.end}),
      prior AS (SELECT b.customer_id, count(*) AS n FROM booking.bookings b JOIN ${confirmed} c ON c.booking_id = b.id
                 WHERE c.at < ${w.end} GROUP BY b.customer_id)
      SELECT
        (SELECT count(*) FROM identity.role_grants WHERE role = 'CUSTOMER') AS customers,
        (SELECT count(*) FROM identity.role_grants WHERE role = 'CUSTOMER'
            AND granted_at >= ${w.start} AND granted_at < ${w.end}) AS customers_new,
        s.searches, s.zero, s.windowed,
        (SELECT count(*) FROM analytics.listing_views WHERE at >= ${w.start} AND at < ${w.end}) AS views,
        (SELECT count(*) FROM booking.bookings WHERE created_at >= ${w.start} AND created_at < ${w.end}) AS requested,
        (SELECT count(*) FROM booking.bookings b WHERE b.created_at >= ${w.start} AND b.created_at < ${w.end}
            AND EXISTS (SELECT 1 FROM booking.booking_events e WHERE e.booking_id = b.id AND e.to_status = 'CONFIRMED'))
          AS requested_confirmed,
        (SELECT count(*) FROM c) AS confirmed,
        (SELECT count(DISTINCT customer_id) FROM c) AS booking_customers,
        (SELECT count(DISTINCT c.customer_id) FROM c JOIN prior p ON p.customer_id = c.customer_id WHERE p.n >= 2)
          AS repeat_customers
      FROM (SELECT count(*) AS searches, count(*) FILTER (WHERE result_count = 0) AS zero,
                   count(*) FILTER (WHERE windowed) AS windowed
              FROM analytics.search_events
             WHERE first_page AND at >= ${w.start} AND at < ${w.end}) s`.execute(db)
      ).rows,
    );
    const searches = n(r.searches);
    const confirmedN = n(r.confirmed);
    const views = n(r.views);
    return {
      customers: { total: n(r.customers), new: n(r.customers_new), withBookings: n(r.booking_customers) },
      // Searches count first pages only: "load more" is the same search (D-159).
      searches: {
        total: searches,
        zeroResult: n(r.zero),
        zeroResultRate: ratio(n(r.zero), searches),
        withTimeWindow: n(r.windowed),
      },
      listingViews: views,
      bookings: {
        requested: n(r.requested),
        confirmed: confirmedN,
        successRate: ratio(n(r.requested_confirmed), n(r.requested)),
      },
      // Aggregate ratios, not a per-person funnel: searches are anonymous (D-159).
      conversion: { searchToBooking: ratio(confirmedN, searches), viewToBooking: ratio(confirmedN, views) },
      repeatCustomers: n(r.repeat_customers),
      repeatRate: ratio(n(r.repeat_customers), n(r.booking_customers)),
    };
  }

  async function marketplace(w: Window) {
    const money = first(
      (
        await sql<{
          gmv: string;
          captures: string;
          refunds: string;
          commission: string;
          service_fee: string;
          tax: string;
        }>`
      SELECT
        coalesce(sum(e.amount_paise) FILTER (WHERE j.kind = 'PAYMENT_CAPTURED' AND a.code = 'CUSTOMER_CLEARING'), 0) AS gmv,
        count(DISTINCT j.id) FILTER (WHERE j.kind = 'PAYMENT_CAPTURED') AS captures,
        coalesce(sum(e.amount_paise) FILTER (WHERE j.kind = 'REFUND' AND a.code = 'CUSTOMER_CLEARING'), 0) AS refunds,
        coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END)
          FILTER (WHERE a.code = 'PLATFORM_COMMISSION'), 0) AS commission,
        coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END)
          FILTER (WHERE a.code = 'PLATFORM_SERVICE_FEE'), 0) AS service_fee,
        coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END)
          FILTER (WHERE a.code = 'TAX_PAYABLE'), 0) AS tax
      FROM ledger.journals j
      JOIN ledger.entries e ON e.journal_id = j.id
      JOIN ledger.accounts a ON a.id = e.account_id
      WHERE j.created_at >= ${w.start} AND j.created_at < ${w.end}
        AND j.kind IN ('PAYMENT_CAPTURED', 'REFUND')`.execute(db)
      ).rows,
    );

    const outcomes = first(
      (
        await sql<{
          confirmed: string;
          cancelled: string;
          by_customer: string;
          by_host: string;
          by_platform: string;
          ended: string;
          no_show: string;
        }>`
      WITH c AS (SELECT b.* FROM booking.bookings b JOIN ${confirmed} c ON c.booking_id = b.id
                  WHERE c.at >= ${w.start} AND c.at < ${w.end})
      SELECT
        (SELECT count(*) FROM c) AS confirmed,
        (SELECT count(*) FROM c WHERE status = 'CANCELLED') AS cancelled,
        (SELECT count(*) FROM c WHERE cancelled_by = 'CUSTOMER') AS by_customer,
        (SELECT count(*) FROM c WHERE cancelled_by = 'HOST') AS by_host,
        (SELECT count(*) FROM c WHERE cancelled_by = 'PLATFORM') AS by_platform,
        (SELECT count(*) FROM booking.bookings WHERE status IN ('COMPLETED', 'NO_SHOW')
            AND upper(period) >= ${w.start} AND upper(period) < ${w.end}) AS ended,
        (SELECT count(*) FROM booking.bookings WHERE status = 'NO_SHOW'
            AND upper(period) >= ${w.start} AND upper(period) < ${w.end}) AS no_show`.execute(db)
      ).rows,
    );

    // Retention: of the hosts / customers with a confirmed booking in the previous window, how many have one in
    // this window.
    const prevStart = new Date(w.start.getTime() - w.days * DAY);
    const retention = first(
      (
        await sql<{ hosts_prev: string; hosts_kept: string; customers_prev: string; customers_kept: string }>`
      WITH c AS (SELECT b.host_account_id, b.customer_id, c.at FROM booking.bookings b
                   JOIN ${confirmed} c ON c.booking_id = b.id WHERE c.at >= ${prevStart} AND c.at < ${w.end}),
      ph AS (SELECT DISTINCT host_account_id AS id FROM c WHERE at < ${w.start}),
      ch AS (SELECT DISTINCT host_account_id AS id FROM c WHERE at >= ${w.start}),
      pc AS (SELECT DISTINCT customer_id AS id FROM c WHERE at < ${w.start}),
      cc AS (SELECT DISTINCT customer_id AS id FROM c WHERE at >= ${w.start})
      SELECT (SELECT count(*) FROM ph) AS hosts_prev,
             (SELECT count(*) FROM ph JOIN ch USING (id)) AS hosts_kept,
             (SELECT count(*) FROM pc) AS customers_prev,
             (SELECT count(*) FROM pc JOIN cc USING (id)) AS customers_kept`.execute(db)
      ).rows,
    );

    const gmv = n(money.gmv);
    const commission = n(money.commission);
    const serviceFee = n(money.service_fee);
    const confirmedN = n(outcomes.confirmed);
    return {
      gmvPaise: gmv,
      refundsPaise: n(money.refunds),
      netGmvPaise: gmv - n(money.refunds),
      platformRevenuePaise: commission + serviceFee,
      commissionPaise: commission,
      serviceFeePaise: serviceFee,
      taxPaise: n(money.tax),
      averageBookingValuePaise: n(money.captures) > 0 ? Math.round(gmv / n(money.captures)) : null,
      cancellation: {
        rate: ratio(n(outcomes.cancelled), confirmedN),
        byCustomer: n(outcomes.by_customer),
        byHost: n(outcomes.by_host),
        byPlatform: n(outcomes.by_platform),
      },
      noShowRate: ratio(n(outcomes.no_show), n(outcomes.ended)),
      retention: {
        hosts: ratio(n(retention.hosts_kept), n(retention.hosts_prev)),
        customers: ratio(n(retention.customers_kept), n(retention.customers_prev)),
      },
    };
  }

  /** One row per IST day, oldest first, for trend charts. */
  async function daily(w: Window) {
    const rows = await sql<{ day: string; searches: string; zero: string; bookings: string; gmv: string }>`
      WITH days AS (
        SELECT d::date AS day FROM generate_series(
          (${w.start}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,
          (${w.end}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d),
      s AS (SELECT (at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS searches,
                   count(*) FILTER (WHERE result_count = 0) AS zero
              FROM analytics.search_events WHERE first_page AND at >= ${w.start} AND at < ${w.end} GROUP BY 1),
      b AS (SELECT (at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS bookings
              FROM ${confirmed} c WHERE at >= ${w.start} AND at < ${w.end} GROUP BY 1),
      g AS (SELECT (j.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, sum(e.amount_paise) AS gmv
              FROM ledger.journals j JOIN ledger.entries e ON e.journal_id = j.id
              JOIN ledger.accounts a ON a.id = e.account_id
             WHERE j.kind = 'PAYMENT_CAPTURED' AND a.code = 'CUSTOMER_CLEARING'
               AND j.created_at >= ${w.start} AND j.created_at < ${w.end} GROUP BY 1)
      SELECT to_char(days.day, 'YYYY-MM-DD') AS day, coalesce(s.searches, 0) AS searches, coalesce(s.zero, 0) AS zero,
             coalesce(b.bookings, 0) AS bookings, coalesce(g.gmv, 0) AS gmv
        FROM days LEFT JOIN s USING (day) LEFT JOIN b USING (day) LEFT JOIN g USING (day)
       ORDER BY days.day`.execute(db);
    return rows.rows.map((r) => ({
      day: r.day,
      searches: n(r.searches),
      zeroResultSearches: n(r.zero),
      confirmedBookings: n(r.bookings),
      gmvPaise: n(r.gmv),
    }));
  }

  return {
    async overview(days: number) {
      const w = windowOf(days);
      const [s, d, m, series] = await Promise.all([supply(w), demand(w), marketplace(w), daily(w)]);
      return {
        window: { start: w.start, end: w.end, days },
        supply: s,
        demand: d,
        marketplace: m,
        daily: series,
      };
    },

    /**
     * Liquidity by ≈1 km cell (0.01°): where customers search, how often they find nothing, and how much supply
     * sits there. Answers "can a customer reliably find a suitable asset nearby?" area by area. Supply cells use the
     * public (fuzzed) point, never the exact one (L-1).
     */
    async liquidity(days: number, assetType?: AssetType) {
      const w = windowOf(days);
      const type = assetType ?? null;
      const rows = await sql<{
        cell: string;
        area_label: string | null;
        searches: string;
        zero: string;
        listings: string;
        bookings: string;
      }>`
        WITH s AS (
          SELECT cell, count(*) AS searches, count(*) FILTER (WHERE result_count = 0) AS zero,
                 mode() WITHIN GROUP (ORDER BY area_label) AS area
            FROM analytics.search_events
           WHERE first_page AND at >= ${w.start} AND at < ${w.end}
             AND (${type}::text IS NULL OR asset_type = ${type}::text)
           GROUP BY cell),
        p AS (
          SELECT a.id, a.status, pr.area_label,
                 round(ST_Y(pr.public_point::geometry)::numeric, 2)::text || ','
                   || round(ST_X(pr.public_point::geometry)::numeric, 2)::text AS cell
            FROM assets.assets a JOIN properties.properties pr ON pr.id = a.property_id
           WHERE ${type}::text IS NULL OR a.asset_type = ${type}::text),
        bk AS (
          SELECT p.cell, count(*) AS bookings
            FROM booking.bookings b JOIN ${confirmed} c ON c.booking_id = b.id JOIN p ON p.id = b.asset_id
           WHERE c.at >= ${w.start} AND c.at < ${w.end}
           GROUP BY p.cell),
        sup AS (
          SELECT p.cell, count(*) FILTER (WHERE p.status = 'PUBLISHED') AS listings,
                 mode() WITHIN GROUP (ORDER BY p.area_label) AS area, coalesce(max(bk.bookings), 0) AS bookings
            FROM p LEFT JOIN bk ON bk.cell = p.cell
           GROUP BY p.cell)
        SELECT coalesce(s.cell, sup.cell) AS cell, coalesce(sup.area, s.area) AS area_label,
               coalesce(s.searches, 0) AS searches, coalesce(s.zero, 0) AS zero,
               coalesce(sup.listings, 0) AS listings, coalesce(sup.bookings, 0) AS bookings
          FROM s FULL JOIN sup ON sup.cell = s.cell
         WHERE coalesce(s.searches, 0) > 0 OR coalesce(sup.listings, 0) > 0 OR coalesce(sup.bookings, 0) > 0
         ORDER BY coalesce(s.zero, 0) DESC, coalesce(s.searches, 0) DESC, coalesce(sup.listings, 0) DESC
         LIMIT 100`.execute(db);
      return {
        window: { start: w.start, end: w.end, days },
        areas: rows.rows.map((r) => ({
          cell: r.cell,
          areaLabel: r.area_label,
          searches: n(r.searches),
          zeroResultSearches: n(r.zero),
          zeroResultRate: ratio(n(r.zero), n(r.searches)),
          publishedListings: n(r.listings),
          confirmedBookings: n(r.bookings),
        })),
      };
    },

    async recordSearch(e: DomainEventMap['discovery.searched'], executor: AnyKyselyExecutor) {
      await sql`INSERT INTO analytics.search_events
          (at, cell, area_label, asset_type, mode, windowed, result_count, first_page)
        VALUES (${minute()}, ${e.cell}, ${e.areaLabel}, ${e.assetType}, ${e.mode}, ${e.windowed}, ${e.resultCount},
                ${e.firstPage})`.execute(executor as unknown as Kysely<unknown>);
    },

    async recordView(e: DomainEventMap['discovery.listing_viewed'], executor: AnyKyselyExecutor) {
      await sql`INSERT INTO analytics.listing_views (at, asset_id) VALUES (${minute()}, ${e.assetId})`.execute(
        executor as unknown as Kysely<unknown>,
      );
    },

    async purgeOldEvents(): Promise<number> {
      const cutoff = new Date(now() - EVENT_RETENTION_DAYS * DAY);
      const a = await sql`DELETE FROM analytics.search_events WHERE at < ${cutoff}`.execute(db);
      const b = await sql`DELETE FROM analytics.listing_views WHERE at < ${cutoff}`.execute(db);
      return Number(a.numAffectedRows ?? 0n) + Number(b.numAffectedRows ?? 0n);
    },
  };
}

export type MetricsService = ReturnType<typeof createMetricsService>;
