# Analytics & Marketplace Intelligence

Phase 21. This document covers what we measure, how each number is computed, and where its data comes from. It also records what we deliberately do not collect.

The question everything here serves (CLAUDE.md §9):

> Can a customer reliably find a suitable asset nearby when they need it?

## 1. Principles

1. **Most metrics come from the systems of record.**
   - Bookings and their event history, the double-entry ledger, assets, availability rules and identity are already authoritative.
   - Analytics reads them read-only and never keeps a second copy that could drift (D-160).
   - Money numbers come from the ledger, so they reconcile with Finance's trial balance.
2. **We capture only behaviour that no system of record holds.** There are two things: searches and listing views. They live in the `analytics` schema (migration 0014).
3. **Nothing identifies a person** (D-159).
   - Discovery events carry no user ID, IP address, session or device.
   - A location is rounded to a 0.01° cell, about 1 km.
   - Times are truncated to the minute.
   - Conversion is therefore an aggregate ratio, not a per-person funnel. That is a deliberate trade: residential search patterns are sensitive (CLAUDE.md §11).
4. **Analytics is best effort.** A failure to record a signal never fails or blocks a search.
5. **Analytics is read-only.** No metric changes marketplace state, and nothing automatic acts on these numbers.

## 2. Event capture

| Event | Published by | Stored as | Fields |
| --- | --- | --- | --- |
| `discovery.searched` | discovery search endpoint, after a successful search | `analytics.search_events` | `at` (minute), `cell` ("12.94,77.62"), `area_label` of the nearest result (null when nothing is found), `asset_type`, `mode`, `windowed` (a time window was given), `result_count` (this page), `first_page` |
| `discovery.listing_viewed` | public listing endpoint, after a successful view (404s are not recorded) | `analytics.listing_views` | `at` (minute), `asset_id` |

- **Delivery.** Events go through the in-process domain event bus. The analytics module subscribes and inserts the rows.
- **Retention.** Rows older than 400 days are purged daily by the `purge-analytics-events` job, at 02:37 UTC (D-161). That is enough for year-on-year comparison.
- **Pages.** A "load more" request is the same search, so search metrics count first pages only.

## 3. Metric definitions

### The window

- Every metric uses a window of `days` (1–365, default 30) ending now: `[now − days, now)`.
- A booking counts in the window when it was **confirmed** in it. Confirmation time is the first `CONFIRMED` entry in `booking.booking_events`.
- Retention compares this window with the window of the same length before it.

### Supply

| Metric | Definition |
| --- | --- |
| Hosts | All host accounts; new ones are those created in the window |
| Hosts live | Active host accounts with at least one PUBLISHED listing |
| Hosts with bookings | Distinct hosts with a booking confirmed in the window |
| Published listings, by type | Assets with status PUBLISHED. Parking is the parking inventory; EV charging is the charger inventory |
| Active units, by type | ACTIVE units of published listings: the bookable spaces or connectors |
| Open unit-hours (availability) | For each published listing: its weekly open hours from its availability rules (capped at 168), × active units × days ÷ 7 |
| Booked unit-hours | Hours of CONFIRMED, IN_PROGRESS, COMPLETED and NO_SHOW bookings inside the window, clipped to it. A no-show still blocked the unit; cancelled and unpaid bookings did not |
| Utilisation | Booked ÷ open unit-hours, by type and overall |

Open unit-hours is the advertised capacity. It ignores one-off blocks and openings, and listings published part-way through the window. That makes utilisation an approximation, good for trends and comparing areas, but not for billing.

### Demand

| Metric | Definition |
| --- | --- |
| Customers | Users with the CUSTOMER role; new ones are those granted it in the window |
| Customers who booked | Distinct customers with a booking confirmed in the window |
| Searches | First-page searches in the window |
| Zero-result searches and rate | Searches that returned nothing, and their share of all searches. **This is the headline liquidity signal (R-01)** |
| Searches with times | Searches that asked for a specific time window |
| Listing views | Successful public listing views |
| Booking requests | Bookings created in the window, including ones that expired, were declined or were never paid |
| Booking success rate | Of those requests, the share that reached CONFIRMED |
| Search → booking | Confirmed bookings ÷ searches. An aggregate ratio (§1.3) |
| View → booking | Confirmed bookings ÷ listing views |
| Repeat customers and rate | Customers who booked in the window and have at least 2 confirmed bookings in total; the rate is their share of customers who booked |

### Marketplace

| Metric | Definition (ledger, journals posted in the window) |
| --- | --- |
| GMV | CUSTOMER_CLEARING debits on PAYMENT_CAPTURED journals: what customers paid |
| Refunds | CUSTOMER_CLEARING credits on REFUND journals |
| Net GMV | GMV − refunds |
| Commission | Net credit to PLATFORM_COMMISSION (refund reversals net it down) |
| Service fees | Net credit to PLATFORM_SERVICE_FEE |
| Platform revenue | Commission + service fees, before tax. Tax (TAX_PAYABLE) is shown separately |
| Average booking value | GMV ÷ number of captured payments |
| Cancellation rate | Of bookings confirmed in the window, the share now CANCELLED, split by who cancelled (customer, host, platform) |
| No-show rate | Of bookings that ended in the window as COMPLETED or NO_SHOW, the share that were NO_SHOW |
| Host retention | Of hosts with a confirmed booking in the previous window, the share with one in this window |
| Customer retention | The same, for customers |

- A ratio with a zero denominator is `null` and shows as "—", never 0%.
- Ratios are rounded to four decimal places.

### Daily trend

For each day in the window (IST, oldest first), we report searches, zero-result searches, confirmed bookings and GMV.

### Liquidity by area

- **Grouping.** Rows are grouped by ≈1 km cell. Search cells come from the search point. Supply cells come from the property's **public (fuzzed) point**, never the exact one (L-1).
- **Columns.** Each row has:
  - searches;
  - zero-result searches and rate;
  - published listings;
  - bookings confirmed in the window;
  - a locality label, taken from the supply in the cell or, failing that, from the searches' nearest results.
- **Order.** Rows are sorted by zero-result searches, then by searches.
- **Use.** The top rows are where customers look and find nothing, which is where to recruit hosts. Cells with supply but no searches are where demand needs marketing.
- **Limits.** Output is capped at 100 rows and can be filtered by asset type.

Search cells and supply cells are approximations of each other. Search covers a radius, and supply cells use the fuzzed point. Read neighbouring cells together.

## 4. Access and API

| Endpoint | Permission | Returns |
| --- | --- | --- |
| `GET /api/admin/v1/analytics/overview?days=` | SUPPORT, TRUST_SAFETY, FINANCE, SUPER_ADMIN | `{window, supply, demand, marketplace, daily}` |
| `GET /api/admin/v1/analytics/liquidity?days=&type=` | same | `{window, areas[]}` |

- Responses are aggregates only, with no personal data.
- Any admin role can see them, because liquidity is everyone's job.
- The admin console's **Analytics** page shows:
  - liquidity cards (searches, zero-result rate, search → booking, booking success, utilisation);
  - daily trend bars;
  - marketplace, supply and demand cards and tables;
  - the liquidity-by-area table.

## 5. Performance

- The queries are aggregates over indexed tables:
  - `search_events (at)`;
  - `listing_views (at)` and `(asset_id, at)`;
  - `booking_events (booking_id, created_at)`;
  - the ledger journal and entry indexes.
- At pilot volume (thousands of bookings, tens of thousands of searches a month), each endpoint is a few queries in tens of milliseconds.
- When a 365-day overview passes about 1 s at p95, add daily rollup tables, refreshed by a job, before reaching for a warehouse (R-82).
- The confirmation-time subquery (`min(created_at)` of CONFIRMED events) is the most expensive part. If needed, it becomes a stored `confirmed_at` on bookings.

## 6. Not built (and why)

| Not built | Reason |
| --- | --- |
| Per-user funnels, cohorts, session tracking | Would need identifying events. Repeat and retention metrics come from bookings instead, which we already hold lawfully |
| Third-party product analytics (GA, Mixpanel, …) | Sends location-bearing behaviour to a third party, and needs a consent banner. Not needed at pilot scale |
| A data warehouse or event streaming | CLAUDE.md §31. PostgreSQL handles pilot volumes |
| Demand forecasting, pricing recommendations | Phase 22 (AI layer) may build these on these metrics, as recommendations only |
| Host-facing analytics beyond earnings | The host earnings page covers money; per-listing views and conversion for hosts are a later candidate |
| Review-manipulation anomaly checks (R-79) | Fraud indicators already flag repeat no-shows, cancellations and duplicate photos. Review anomalies need more data than the pilot will have |

## 7. Liquidity playbook (how to use the numbers)

1. **Zero-result rate above about 30% in a cell with steady searches.** Recruit hosts there: target societies, offices, and the houses near them.
2. **High views but low view → booking.** Check price, photos and availability for listings in that area. Booking success below about 70% points at host approval delays or payment failures.
3. **Utilisation above about 60% in an area.** Supply is tight. Recruit there before customers start seeing zero results.
4. **Utilisation below 5% with published supply.** Demand needs marketing, or the listings are mispriced or badly described.
5. **Host cancellations or no-shows rising.** Look at the fraud indicators and the trust signals per host and customer.
