# PROJECT STATUS

Last updated: 2026-10-20

## CURRENT PHASE
Phase 23: Production Hardening & Launch (final phase)

## STATUS
PHASE STATUS: COMPLETE

## COMPLETED PHASES
- Phase 0: Product Discovery & Repository Audit (2026-10-19)
- Phase 1: Market & Competitive Research (2026-10-19)
- Phase 2: Domain & Marketplace Model (2026-10-19)
- Phase 3: UX & User Journey Architecture (2026-10-19)
- Phase 4: Trust, Safety & Verification (2026-10-19)
- Phase 5: Technical Architecture (2026-10-19)
- Phase 6: Database Architecture (2026-10-19)
- Phase 7: Project Foundation (2026-10-19)
- Phase 8: Identity & Authorization (2026-10-20)
- Phase 9: Property & Asset Management (2026-10-20)
- Phase 10: Location & Discovery (2026-10-20)
- Phase 11: Availability Engine (2026-10-20)
- Phase 12: Booking Engine (2026-10-20)
- Phase 13: Parking Experience (2026-10-20)
- Phase 14: EV Charging Experience (2026-10-20)
- Phase 15: Payments (2026-10-20)
- Phase 16: Host Earnings & Payouts (2026-10-20)
- Phase 17: Access Management (2026-10-20)
- Phase 18: Notifications (2026-10-20)
- Phase 19: Reviews, Trust & Disputes (2026-10-20)
- Phase 20: Admin Platform (2026-10-20)
- Phase 21: Analytics & Marketplace Intelligence (2026-10-20)
- Phase 22: AI Layer (2026-10-20)
- Phase 23: Production Hardening & Launch (2026-10-20)

## CURRENT WORK
All 24 phases (0–23) are complete. A private, invite-only **staging deployment for Render** is defined in `render.yaml` (D-172; guide in `docs/deployment-render.md`). The code is ready for a controlled pilot; launch is blocked on external dependencies and owner actions (`docs/launch-checklist.md` §1). Local dev: `pnpm db:up && pnpm db:migrate && pnpm db:seed`, then `pnpm dev:api` and `pnpm dev:web` (sign in with 9000000001/2/3, code 246810); admin console `pnpm dev:admin` at http://localhost:4102 with 9000000009, code 246810, then `pnpm admin:dev-code` for the authenticator code.

## IMPLEMENTATION SUMMARY

### Phase 23: Production Hardening & Launch
| Area | What was done |
|---|---|
| Security audit | Route-security inventory (guard markers + test with a reviewed public allowlist); SQL-injection sweep (none); dependency audit (production clean; handlebars override); admin exact-address views audited (R-56 closed). |
| Trust / legal fixes | Pilot customer clearance gate (D-168, R-62 mitigated); data-rights requests with admin queue and erasure runbook (D-169, R-55 mitigated). Migrations 0016, 0017. |
| Observability | `ops` module: 16 symptom checks with thresholds; `/api/health/ops` for monitors (503 on critical); admin dashboard Operations panel (D-170). |
| UI | Admin: Operations panel, pilot clearance on user detail, Data requests queue. Web: "Your data" on the account page. |
| Docs | New `production-readiness.md`, `launch-checklist.md` (incl. pilot plan), `final-qa.md`; D-168 to D-171; R-55, R-56, R-62 updated; R-86 to R-88; api-design, database-design §16. |

### Phase 22: AI Layer
| Area | What was built |
|---|---|
| Schema (0015) | `ai.invocations`: model, cost, latency, errors, fallbacks, tool calls, fields understood, feedback; no text, no user; 400-day purge job. |
| AI module | `LlmProvider` seam (Anthropic Messages API with a forced tool, no SDK; scripted provider for tests); strict Zod intent → JSON Schema; redaction; deterministic normalisation and chips; geocoder as the only place tool; rules-parser fallback (no provider, budget, timeout, error, invalid output); daily budget; env `AI_*`. |
| Feature | Natural-language parking and EV search: `POST /v1/ai/search-intent` + feedback; web "Describe what you need" box fills and runs the regular search; filters gained max price and AC/DC. |
| Tracking / eval | Admin `/admin/v1/ai/usage` and an AI table on the Analytics page; evaluation set (17 cases incl. injection) and `pnpm ai:eval` (≥ 90 % bar; rules baseline 73/73). |
| Docs | New `docs/ai-strategy.md`; D-163 to D-167; R-35 mitigated, R-84, R-85; api-design, database-design, ux §16k. |

### Phase 21: Analytics & Marketplace Intelligence
| Area | What was built |
|---|---|
| Schema (0014) | `analytics.search_events`, `analytics.listing_views`: anonymous (no user/IP, ≈1 km cell, minute times), 400-day retention job. |
| Capture | Discovery publishes `discovery.searched` / `discovery.listing_viewed` after successful requests; the analytics module records them best effort. |
| Metrics | Read-only `analytics` module: supply (hosts, listings and units by type, open vs booked unit-hours, utilisation), demand (customers, searches, zero-result rate, views, requests, booking success, conversion, repeat customers), marketplace (GMV, refunds, net GMV, commission, service fees, revenue, tax, ABV from the ledger; cancellation by party, no-show, host/customer retention), daily trend, liquidity by area. |
| API / console | `/admin/v1/analytics/overview` and `/liquidity` (any admin permission); admin **Analytics** page. |
| Docs | New `docs/analytics.md`; D-159 to D-162; R-01 updated, R-82, R-83; api-design, database-design, architecture, ux §16j. |

### Phase 20: Admin Platform
| Area | What was built |
|---|---|
| API | Module-owned admin lists with search/filters/pagination (users, hosts, properties, listings, bookings, payments, refunds, payouts, reviews); user/booking details; suspend/reinstate (sessions revoked), host status, platform booking cancellation; `admin` module: audit log viewer, read-only config, fraud indicators from module signals. |
| Console (`apps/admin`) | Shell with navigation and session; dashboard queues + search; lists and detail screens for every entity in PHASES.md; inline reason forms for every action. |
| Dev | `pnpm admin:dev-code`. |
| Docs | D-154 to D-158; R-56, R-80 updated, R-81; api-design, ux §16i. |


### Phase 19: Reviews, Trust & Disputes
| Area | What was built |
|---|---|
| Schema (0013) | `reviews.reviews`; `disputes.disputes`, `dispute_messages` (append-only, internal notes), `dispute_evidence`; refund reason DISPUTE. |
| Reviews | Two-sided, blind, 14-day window, dimensions, contact-detail filter, publication job, moderation, public listing reviews (average from 3). |
| Trust signals | Customer (verification, completed, no-shows, host rating) and host (completed, host cancellations) signals; shown to hosts. |
| Disputes | Nine categories, risk levels, timeline, evidence photos (metadata stripped), admin queue and evidence pack, state machine, human-only resolution (HIGH → TRUST_SAFETY), refunds via payments, earnings hold, audit, notifications. |
| UI | Review form, dispute entry and page, listing reviews, customer trust for hosts. |
| Dev | `pnpm db:seed` sample data; configurable OTP verify limit. |
| Docs | D-148 to D-153; R-79, R-80; api-design, database-design, ux §16h. |


### Phase 18: Notifications
| Area | What was built |
|---|---|
| Schema (0012) | `notifications.notifications` (outbox + delivery + inbox), `notifications.preferences`. |
| Outbox | Subscribers to booking, payment, refund, charging, payout, payout-account and issue events write rows in the causing transaction; dedupe per event × recipient × channel. |
| Delivery | Worker with lease, retries/backoff, permanent failures, suppression; signed delivery webhooks; render at send time; phone decrypted only then. |
| Providers | `MessagingProvider` seam; console (dev) and memory (tests); production `none` until vendors exist. |
| Time-based | Reminder, access open, ending soon (scheduler + dedupe). |
| UI | Inbox page, nav link, WhatsApp/SMS preferences. |
| Docs | D-143 to D-147; R-77, R-78; api-design, database-design, ux §16g. |


### Phase 17: Access Management
| Area | What was built |
|---|---|
| Schema (0011) | `access.gate_tokens`, `access.access_grants`, append-only `access.access_events`; `booking.booking_issues`. |
| Grants | Issued in the confirming transaction, revoked when the booking closes; code (hashed + encrypted), plate binding, signed driver pass; reissue. |
| Guard | Per-gate links (owner/admin), lookup by full plate/code/pass, minimal answers, gate-bound entry tickets, rate limits, access log. |
| Check-in & no-show | Guard entry / adapter / "I'm here" → IN_PROGRESS; host-reported no-show with safeguards. |
| Recourse | "I can't get in" issues, 15-minute host window, automatic full refund job, escalation; charger faults open issues. |
| Adapters | `AccessAdapter` seam (smart lock, ANPR, gate, society) and `ingestExternal` for inbound events. |
| UI | Get in panel, driver pass page, guard page, host gates/access log, host issue response and no-show, Today problems first. |
| Docs | D-136 to D-142; R-74 to R-76; api-design, database-design, ux §16f. |


### Phase 16: Host Earnings & Payouts
| Area | What was built |
|---|---|
| Ledger (0010) | Double-entry accounts, idempotent journals, entries with a deferred balance check, append-only. Trial balance (FINANCE). |
| Split | Pure capture/refund split: customer payment, service fee, commission, tax (0 pending CA), host net; proportional refunds. |
| Postings | Capture and refund journals in the payment transaction (events); refund after release or payout → available or receivable; hourly backfill. |
| Release & payouts | Pending → available 48 h after the booking ends; weekly MANUAL payout run (≥ ₹100, verified unheld account, active host, receivable offset first); finance settles with UTR or failure. |
| Payout accounts | UPI/bank, encrypted, masked, owner-only, FINANCE verification, 72 h hold on change. |
| UI | Host earnings page (balances, per-booking gross/fees/commission/net, payout account, payouts). |
| Docs | D-128 to D-135; R-71 to R-73; api-design, database-design, ux §16e. |


### Phase 15: Payments
| Area | What was built |
|---|---|
| Schema (0009) | `payments.payments`, `payment_events`, `refunds` (cap trigger), `provider_events` (dedupe + claim lease), `settlement_lines`, `reconciliation_items`. |
| Providers | `PaymentProvider` interface; Razorpay adapter (orders, payment query, capture, refunds by receipt, settlements, HMAC webhooks, checkout signature); fake simulator for dev/tests. Env: `PAYMENT_PROVIDER`, `RAZORPAY_*` (production refuses fake and test keys). |
| Flow | Initiation (idempotent, reuses an open attempt) → checkout → webhook or server query → single success path with amount check → booking confirmation, or automatic full refund (late/unavailable, duplicate). Failed attempts recorded; retry on the same order allowed. |
| Refunds | Cancellation policy amounts (Phase 12) flow via `booking.refund_due` events into PENDING refunds; job submits; webhooks/queries settle; failure → finance. |
| Reconciliation | Missed webhooks, expiry, stuck confirmations, refund status (5 min); daily settlement import and matching; FINANCE reconciliation queue API. |
| UI | Pay button, Razorpay checkout or test checkout, confirming-payment wait, failure copy. CSP frame-src for the provider (customer web only). |
| Docs | D-120 to D-127; R-68 to R-70; api-design (payments), database-design §3 as built, ux §16d. |


### Phase 14: EV Charging Experience
| Area | What was built |
|---|---|
| Charging module (0008) | `charging.charging_sessions` (one per EV booking) + `session_events`; `charger_details.integration_kind/ref`. Pure session state machine, start window, speed classes, energy planning bound. |
| Integration seam | `ChargerIntegration` interface + MANUAL adapter + registry injected via composition (`chargerIntegrations` override); refusal and metering paths tested with a fake adapter. |
| API | Customer start / stop / fault and view; host read-only view; `charging-sessions` job completes/stops sessions with their booking. |
| Already in place, verified | Charger details (connectors, AC/DC, power, cable, connection), connector compatibility at booking (BR-12), per-hour / per-session pricing, availability via the generic engine, charger photo + safety attestation gating publish. |
| UI | Host: EV listing creation and editor sections. Driver: speed label, EV-aware vehicle form and search, charging panel on the booking; host sees the session. |
| Docs | D-114 to D-119; R-66, R-67; api-design (charging), database-design, domain-model, ux §16c. |


### Phase 13: Parking Experience
| Area | What was built |
|---|---|
| Monthly booking architecture (0007) | `booking.booking_series` + append-only `series_events`; bookings gain `series_id` / `period_index`. Pure series domain (period windows with month-end clamping that keeps the anchor day, notice end, state machine). Monthly requests always need host approval. |
| Series lifecycle | Renewal held on the same space when a period starts (payable by its start, 3-day grace), past due, grace lapse, notice by customer or host (15 days, period boundary, later periods released/refunded), host termination with full refunds, end when the space is no longer available. `booking-series` job every 5 min; lock order series → property → asset → bookings. |
| Recurring architecture | `cadence` seam (only MONTHLY allowed) documented for weekday patterns (D-109). |
| Archive guard | No archive while a holding booking ends in the future (D-071/D-110). |
| Customer UI | Booking box for hourly, daily, overnight and monthly; search window prefill; "See other spaces nearby" on unavailability; Monthly plans list and plan page with notice; booking detail links to its plan and hides cancel for running plans. |
| Host UI (`/host`) | Become a host; Today (requests with approve/decline, next 48 h, drafts); Listings; create (property + title); section-by-section editor with checklist (details, spaces, photos, prices incl. overnight window, schedule presets, rules & private access, settings, confirmation) and Submit / Pause / Publish again / Archive; Calendar day view with blocks; Bookings with approve / decline / cancel; Monthly plans with notice. |
| Docs | D-104 to D-113; R-63 to R-65; api-design (monthly plans), database-design (series as built), ux-architecture §16b. |


### Phase 12: Booking Engine
| Area | What was built |
|---|---|
| Schema (0006) | `users.vehicles` (encrypted plate + blind index, unique among active), `pricing.quotes`, `booking.bookings` (exclusion constraint on unit × blocked period for holding states, trigger-set buffer, `UNIQUE (customer_id, idempotency_key)`, `UNIQUE (quote_id)`, status/cancellation CHECKs), append-only `booking.booking_events`. |
| Domain (pure, unit-tested) | Quote calculator (hourly/daily ceil, overnight exact window, monthly = +1 calendar month, per-session, bps half-up); booking state machine (explicit statuses and actions); cancellation policies FLEXIBLE / MODERATE / STRICT (`cancellation-v1`) and refund calculation; Indian plate normalisation. |
| Create transaction | Quote lock → property (if capped) → asset FOR SHARE → expire lapsed holds in the way → engine re-check on the transaction → outsider cap → insert with SAVEPOINT retry on the next unit → quote used → event + audit. Vehicle fit and EV connector checks; own-listing refusal; idempotency; 20 bookings/h and 120 quotes/h per customer. |
| States | Holds only: `PENDING_PAYMENT` (10 min) or `AWAITING_HOST_APPROVAL` (≤ 12 h, never past start). Host approve / decline / cancel (full refund), customer cancel (policy refund, preview). `confirmPayment` is internal only (Phase 15). |
| Availability consumers | Real `ReservationSource`: search, window check and host calendar see holding bookings; lapsed holds never block. |
| Privacy (L-6) | Exact address, space label and access instructions only for the customer of a CONFIRMED/IN_PROGRESS booking until end + 24 h. Hosts see "First L." and the plate. |
| Jobs | pg-boss 12 runner (`pgboss` schema, singleton queues): expire holds (1 min), complete finished bookings (5 min), purge rate-limit windows, quotes and OTP challenges (hourly). Replaces the opportunistic cleanup (D-059 → D-097). `JOBS_ENABLED`. |
| Web | Listing booking box (sign in → add vehicle → date/time → server price → reserve with an Idempotency-Key), `/bookings` (upcoming/past), `/bookings/[id]` (status, hold countdown text, "payments coming soon", access block once confirmed, cancel with refund confirmation). Nav link. |
| Docs | Decision log D-092 to D-103; risks R-39, R-40 mitigated, R-54, R-58 closed, R-60 to R-62 new; api-design (vehicles, quotes, bookings, host bookings, error codes); database-design §6.5–6.6 as built. |


### Phase 11: Availability Engine
| Area | What exists |
|---|---|
| Engine | `availability/domain/engine.ts` (pure): free time per unit = weekly rules ∪ OPEN exceptions − BLOCK exceptions (asset-wide or per unit) − holding reservations (each covering start → end + buffer). `checkUnit` (window inside open time, window + buffer clear of reservations), `availableUnits` (BR-05), `assetCheck` with the most useful reason, `freeTime`, interval `subtract`, and `maxConcurrent` for the property cap (BR-06). Half-open, property timezone, DST-safe (Phase 10 rule expansion). |
| Bookings seam | `ReservationSource` interface (D-085), default `noReservations`; injected through `composition.ts` into assets and discovery. Phase 12's booking module implements it inside the caller's transaction. |
| Data | Migration `0005`: `availability.availability_exceptions` (GiST); discovery views gain unit ids, exceptions (no reasons) and `buffer_minutes`. |
| Host API | Blocks and openings (`POST/DELETE …/availability-exceptions`): validated (future, whole minutes, ≤ 366 days, own unit), audited. A BLOCK locks the asset FOR UPDATE and refuses overlap with reservations incl. buffers (BR-04, D-086/D-087). Calendar `GET …/calendar` (≤ 62 days): free time per space, exceptions with reasons, reservations. |
| Public API | Search uses the engine for windowed queries. New `GET /v1/listings/{id}/availability` returns available or a specific reason (CLOSED, BLOCKED, RESERVED, NO_UNITS, INVALID_WINDOW, LEAD_TIME, DURATION). |
| Docs | Decision log D-084 to D-091; database-design §7, domain-model, api-design updated; risk register (R-12, R-23, R-58). |

### Phase 10: Location & Discovery
| Area | What exists |
|---|---|
| Privacy-safe data | Migration `0004`: `discovery.published_listings`, `published_rates`, `public_photos`, `published_availability_rules` views. They physically lack exact location, address, access instructions, storage keys and owner ids, and include only PUBLISHED listings of ACTIVE hosts at NOT_REQUIRED/PARTICIPATING properties (D-074). |
| Search API | `GET /v1/listings/search`: radius over the fuzzed public point (GiST); parking filters (covered, security all-of, EV-ready, vehicle size, mode, max price); EV filters (connectors any-of, AC/DC, min kW); sort by distance or price; keyset cursors bound to the query; distances rounded to 100 m; headline price per mode; first public photo; badges. Validation of inconsistent queries. |
| Coarse availability | Weekly rules must cover the whole window in the **property's timezone** (Luxon), plus lead time; min/max duration for hourly and charging modes (D-076). `availabilityChecked` flag. Exceptions and bookings: Phase 11. |
| Listing API | `GET /v1/listings/{id}`: public view (area label, AREA/PIN precision, coordinates rounded to ~110 m, host first name (L-8), space count only for commercial (L-7), public photos only, all rates, weekly schedule, booking terms). |
| Places | `Geocoder` provider interface with a Bengaluru fixture (15 localities); autocomplete and details endpoints. Production refuses the fixture (AR-3). |
| Abuse / liquidity | Per-IP (hashed) rate limits: search 60/min, listing 120/min, places 120/min. Anonymous search signal (~1 km cell, type, mode, result count) for zero-result tracking (R-01). |
| Customer UI | `/search` (autocomplete or my location, parking/EV, booking type, IST date and time window, filters, sort, show more, empty state with "search within 10 km", errors) and `/listings/[id]` (server-rendered: gallery, facts, charger, schedule, rules, prices, host first name, approximate-area notice, disabled "Booking opens soon"). Home and nav link to search. No map yet (AR-3). |
| Fixes | `pg` DATE parsing (D-080, affected Phase 9 host views too); per-IP OTP limit configurable (D-081). |
| Docs | api-design (discovery endpoints), database-design §5, trust-and-safety L-9 done, ux-architecture §16 as built, decision log D-074 to D-083, risk register (R-01, R-14, R-19 updated; R-58, R-59 new). |

### Phase 9: Property & Asset Management (API only; host screens in Phases 13/14, D-063)
| Area | What exists |
|---|---|
| Database | Migration `0003`: `identity.host_accounts` / `host_members`; `properties.properties` (exact address and point encrypted, stable fuzzed `public_point` with a GiST index, participation status, CHECK that societies have no single owner), `property_members`, `property_events`; `assets.asset_types` (seeded PARKING, EV_CHARGING), `assets`, `asset_units`, `parking_details` (bay, both types), `charger_details`, `asset_media` (dHash, duplicate flag, capture distance, moderation), `asset_events`; `pricing.rates` (history kept); `availability.availability_rules` (storage only); `trust.verification_records`. |
| Host accounts | `POST/GET /v1/host/account` (grants HOST, one owned account per user); a shared guard for host-only routes (restricted hosts are read-only). |
| Properties | Host-owned houses, commercial, office, other. **Stable fuzzed public point** (200–500 m residential and unknown, 0–100 m commercial and office), redrawn only when the exact point moves. India-only service area. Locality-only area labels (no digits or contacts). Timezone validation. Optimistic concurrency. |
| Societies (BR-32) | Admin-created (`CONSENT_REQUIRED`). Participation state machine (incl. D-066). Admin-approved member hosts. Halting participation or revoking membership suspends the affected listings (domain events, atomic). |
| Generic assets | One engine for PARKING and EV_CHARGING (type registry). Create, read, list, edit (optimistic concurrency, strict schemas); bay and charger details (type-checked); units (deactivate, never delete); rates (mode and unit validated per type, retire-not-edit history); availability rules (validated, ≤ 14); versioned attestations; access instructions encrypted (private until booking). |
| Lifecycle | Asset state machine (domain-model §5.1): submit → human review → approve/reject; pause/republish; material change (photos, property location) → re-review; suspend/reinstate; archive. A **publish checklist** returns exactly what is missing (details, units, photos per type, rate, availability, attestations, society consent, membership, host status). History in `asset_events`, audit for every action. |
| Photos | Raw JPEG/PNG/WebP ≤ 10 MB, ≤ 10 per listing, 60 uploads per hour per host. sharp decode → auto-rotate → ≤ 2048 px → WebP with **all metadata stripped (incl. GPS)**. dHash near-duplicate flag across hosts. Optional capture location gives a V-GEO distance. Private object storage (local disk in dev, memory in tests). Access: owner always; public only for approved, non-entrance photos of published listings; admin route. |
| Trust & safety | Contact-detail detection blocks phones, emails, URLs, UPI IDs and messaging handles in public text. Every listing is human-reviewed (pilot). The reviewer sees duplicate flags and capture distance but not private access instructions. |
| Admin API (TRUST_SAFETY) | Review queue, asset detail, approve, reject, suspend, reinstate, admin media; society create, participation, member hosts. (UI in Phase 20.) |
| Architecture | New modules: properties, assets, pricing, availability, trust, each with its own schema and public `index.ts`. `src/composition.ts` wires all modules (used by main, CLI and tests). In-process domain event bus (D-065). Object storage provider. |
| Docs | api-design.md (Phase 9 endpoints and error codes), decision log D-063 to D-073, risk register (R-08, R-14, R-30 updated; R-56 and R-57 new), domain-model, database-design and trust-and-safety "as built" notes. |

### Phase 8: Identity & Authorization
| Area | What exists |
|---|---|
| Database | Migration `0002_identity`: `identity.users` (phone encrypted, keyed-hash lookup, last-4 for display), `role_grants`, `admin_permissions`, `admin_mfa`, `sessions` (token hash only), `otp_challenges`, `consents`; `platform.audit_events` (append-only) and `platform.rate_limit_counters` (UNLOGGED). |
| Platform | AES-256-GCM field cipher with a key-versioned keyring and per-column context binding; keyed HMAC hasher (blind indexes, OTP and ticket hashing); UUIDv7; Postgres rate limiter (shared across instances, `Retry-After`); audit log (transaction-aware); OTP provider interface (console, memory, noop); `createPlatformServices` factory. |
| Registration and login | Phone OTP: uniform response (no enumeration), 5-minute codes as keyed HMAC, 5 attempts, newest supersedes older. New numbers get a single-use 15-minute registration ticket. Registration requires 18+ attestation and the current notice version, and creates the CUSTOMER role and TERMS/PRIVACY consents atomically. Concurrent registration of the same number results in one account. Suspended users are refused. |
| Sessions | `identity.sessions` implements the Phase 7 `SessionResolver`. USER 30 d idle / 90 d absolute, ADMIN 60 min / 8 h. Sliding expiry is written at most every 5 min. Logout, revoke-own-device and listing devices are supported. Revocation, suspension and admin-role removal take effect immediately. |
| Profile | `GET/PATCH /v1/me` (name, language), strict schema (no mass assignment), audited with field names only. |
| Roles and authorization | CUSTOMER, HOST, PROPERTY_ADMIN, PLATFORM_ADMIN; `requireUser`, `requireRole`, `requirePermission` (admin sessions only; SUPER_ADMIN implies all), `assertOwner` (others' resources → 404). |
| Admin | OTP + mandatory RFC 6238 TOTP (own implementation, RFC vectors pass, ±1 step, replay-protected, 5 attempts per ticket, 10 per hour). Separate `__Host-pb_admin` cookie. CLI `admin:grant` enrols TOTP and prints the URI once. |
| Rate limits | OTP send: 1/30 s and 5/h per number (shared across user and admin), 20/h per IP. Verify: 60/h per IP. TOTP: 10/h per admin. Keys hash phone and IP. |
| Environment | `FIELD_ENCRYPTION_KEYS`, `BLIND_INDEX_KEY`, `OTP_PROVIDER` (`console` or `dev-fixed`), `OTP_DEV_FIXED_CODE`. Outside development/test the API refuses the public dev keys and refuses to start without a real OTP provider (D-057). |
| Web app | Per-request **nonce CSP** via `proxy.ts` (no `unsafe-inline`; resolves R-51). Sign-in / sign-up flow (phone, code with resend countdown, registration with consent), account page (profile, language, devices with revoke, sign out), draft Terms and Privacy pages. Accessible forms (labels, hints, `aria-describedby`, alerts), loading, error and success states. Open-redirect-safe `?next=`. |
| Admin app | Nonce CSP, noindex; sign-in (phone, SMS code, authenticator code); signed-in page with permissions and sign out. |
| Shared packages | `packages/web-kit` (API client → typed `ApiError`, `safeNextPath`), `packages/config` (security headers + CSP builder). |
| E2E | `e2e/` Playwright 1.63 against **production builds** on ports 4110–4112 with a fresh `parkbro_e2e` DB. CI runs it. |
| Docs | New `docs/api-design.md`. Updated decision log (D-054 to D-062), risk register (R-51 closed; R-15, R-17, R-46 updated; R-53 to R-55 new), database-design (identity as built), README. |

### Phases 0–7 (summary)
- **Phases 0–6:** design. Product, research, domain, UX, trust & safety, architecture, database (PostgreSQL-validated prototype in `docs/db-prototype/`).
- **Phase 7:** foundation. Monorepo, native-TypeScript Fastify API, env validation, migrations, problem+json errors, logging, CSRF, security headers, auth plumbing, Next.js apps, CI.

## TEST RESULTS

### Phase 23 (2026-10-20)
- **`pnpm check` exit 0.** API **607 tests** in 42 files (was 600): `route-security.test.ts` (3), `ops.test.ts` (2), `pilot-clearance.test.ts` (1), `data-requests.test.ts` (1); admin test now asserts the audited address reveal.
- **E2E 30/30** on production builds with strict CSP; the auth journey now files a data request.
- `pnpm audit --prod`: 0 vulnerabilities. `pnpm ai:eval` (rules): 73/73. Local latency (dev data): search p95 9 ms, listing p95 38 ms.


### Phase 22 (2026-10-20)
- **`pnpm check` exit 0.** API **600 tests** (was 567): `ai-domain.test.ts` (25: rules parser passes all 17 evaluation cases and doesn't guess; strict contract rejects actions/ids/coordinates/bad values; redaction; normalisation; chips; evaluator scoring) and `ai.test.ts` (8: model intent → validated filters with the geocoder's point and exact usage row incl. cost; four malicious/invalid outputs rejected → rules; timeout and error fallback; contact details never reach the model and no text stored; unknown place/unsupported notes; input validation, per-IP rate limit, one-time feedback; admin usage with fallbacks/feedback and no text; budget cap stops model calls; no-provider path).
- **E2E 30/30** (both viewports): new journey "describe what you need" → chips → form filled (place, connector) → regular search ran → feedback.


### Phase 21 (2026-10-20)
- **`pnpm check` exit 0.** API **567 tests** (was 564): `analytics.test.ts` (3: stored search rows carry only cell/area/type/flags; exact supply numbers incl. 720 open vs 2 booked unit-hours with cancelled and unpaid bookings excluded; exact demand numbers — 4 searches, 50 % zero-result, 3 requests / 2 confirmed, conversion, repeat customer; GMV and ABV equal to the bookings' totals, revenue = commission + fees, cancellation 50 % by customer, undefined ratios null; daily series sums; liquidity rows for a no-supply cell and the supplied cell; admin-only endpoints with window validation and no personal data; 400-day purge).
- **E2E 28/28:** the admin journey now opens the Analytics page.


### Phase 20 (2026-10-20)
- **`pnpm check` exit 0.** API **564 tests** (was 558): `admin.test.ts` (6: every admin endpoint refuses user sessions and wrong permissions; exact-phone search without leaking numbers; suspension needs TRUST_SAFETY and a reason, revokes sessions, is audited, reinstate; host restriction hides listings from discovery; booking filters/detail/platform cancel with full refund visible to finance; paginated lists without addresses; fraud indicators and config without secrets). Found and fixed: session revocation lacked the required revoke reason (500).
- **E2E 28/28:** admin journey now covers the console (dashboard, users list search).


### Phase 19 (2026-10-20)
- **`pnpm check` exit 0.** API **558 tests** (was 551): `reviews-disputes.test.ts` (7: blind publication and listing view, eligibility/contact filter/window publication, averages from 3 + trust signals + moderation permissions, dispute open/timeline/evidence with GPS stripped/privacy/notifications, evidence pack + request-info loop + internal notes hidden + partial refund through payments + audit, HIGH-risk only TRUST_SAFETY + customers can't resolve + refund cap, earnings hold until resolution).
- **E2E 28/28:** new journey (book → pay → completed → review stays hidden → open dispute → message). Found an e2e-only limit (OTP verify per IP) and made it configurable.


### Phase 18 (2026-10-20)
- **`pnpm check` exit 0.** API **551 tests** (was 538): `notifications-domain.test.ts` (5: channel policy incl. critical override and availability, rendering limits, retry schedule) and `notifications.test.ts` (8: outbox rows from a confirmed booking for customer and host with no personal data, delivery once, transient retry with backoff, permanent failure, give-up after 6 attempts, signed forward-only delivery receipts, opt-outs vs critical SMS, request/approve/cancel/refund messages, reminder/start/ending once each, private inbox and read marking). The retry test was made order-independent after one flaky run; 4/4 repeats green.
- **E2E 26/26:** access journey now checks the inbox (confirmation, payment, mark all read); e2e server logs show redacted console deliveries.


### Phase 17 (2026-10-20)
- **`pnpm check` exit 0.** API **538 tests** (was 527): `access.test.ts` (11: grant issue and privacy, revocation everywhere, reissue, check-in window, guard by code/plate with minimal answer and plate binding, ticket gate-binding and forgery, cross-property refusal, owner-only gates, hashed tokens, rate limit, access log, gate revocation, signed driver pass, ANPR ingestion, recourse fix vs automatic full refund, issue window/escalation, no-show safeguards and release); charging fault now asserts its recourse issue.
- **E2E 26/26:** new access journey (book now → pay → code → guard link denies a wrong code, verifies the right one, shows the plate not the name, allows entry → "You're parked" → "I can't get in" → host fixes → access log).
- Bug found and fixed: signed pass URLs exceeded the 100-character path limit (414) → compact tokens (D-142).


### Phase 16 (2026-10-20)
- **`pnpm check` exit 0.** API **527 tests** (was 511): `earnings-domain.test.ts` (6: split sums, tax carve-out, rounding, proportional refunds) and `earnings.test.ts` (10: capture split and balanced ledger, partial refund, late-payment full refund nets zero, release window + idempotency, payout run + MANUAL settlement + FINANCE-only, receivable after payout offset by the next run, failed payout returns funds, encrypted/masked payout account + 72 h hold, earnings isolation, append-only and balance enforcement, backfill once).
- **E2E 24/24.** The EV journey now checks host earnings (₹108 pending, commission ₹12) and adds a UPI payout account. Found and fixed a real UI race: the host calendar could show a stale day when the date changed quickly (latest-request guard); host spec then passed 6/6 on repeat.
- `pnpm audit --prod`: clean.


### Phase 15 (2026-10-20)
- **`pnpm check` exit 0.** API **511 tests** (was 484): `payments.test.ts` (20) covering the required cases: successful payment (webhook; server query after return; authorized → captured), failed payment (and success on retry), duplicate webhook (sequential and concurrent), delayed webhook (revive; refund when the space is gone; duplicate payment refund), refund (customer policy, host full, none when unpaid, cap trigger, provider outage → finance), payment mismatch (quarantined, never confirms), unknown order, reconciliation (missed webhook, expiry with honoured late capture, stuck confirmation), settlement import (idempotent, unknown lines flagged), FINANCE-only queue, authorization, simulated checkout through the signed path. `razorpay.test.ts` (6) and env guards.
- **E2E 24/24:** EV journey now pays through the provider checkout (no DB shortcut); booking journey shows a failed payment keeping the hold.
- `pnpm audit --prod`: clean. **Not run:** Razorpay sandbox (no keys; R-68).


### Phase 14 (2026-10-20)
- **`pnpm check` exit 0.** API **484 tests** (was 474): `charging-domain.test.ts` (4) and `charging.test.ts` (6: start/stop through the integration with energy, booking state untouched; concurrent starts → one session, one hardware start; confirmed-only, window and parking-booking refusals; refusing charger and fault + audit; ownership and host read-only; job completion and cancellation stop).
- **E2E 24/24** (mobile + desktop), new EV journey: host builds an EV listing in the UI (bay, charger, two photos, per-hour price, both attestations) → admin approves → driver signs up from the listing, adds an EV, books a session now → (test-only DB confirmation standing in for the Phase 15 webhook) → start → stop → host sees the session.
- Bug found and fixed: the completion job could write an end before the start after a booking was shortened (defensive max). `pnpm audit --prod`: clean.


### Phase 13 (2026-10-20)
- **`pnpm check` exit 0.** API **24 files / 474 tests** (was 456): `series-domain.test.ts` (7: month-end clamping, leap year, contiguity, DST wall time, notice boundaries, state machine) and `series.test.ts` (11: request → plan, decline/lapse ends it, withdraw vs. notice-only, renewal held and idempotent, past due → grace lapse, late renewal, unavailable space ends plan, customer and host notice boundaries, host termination refunds, notice-vs-payment race without deadlock, archive guard). Three consecutive full runs green.
- **E2E 22/22** (mobile + desktop): new host journey (become host → create → fill every section incl. photo upload → submit → admin approve → live → monthly request on Today → approve → plan and booking detail without customer phone → calendar shows the hold and refuses a block over it) and customer monthly request from the listing (mode prefilled from the URL → plan page → Monthly plans list).
- **Bugs found by tests and fixed:** host notice passed the host account's own `kind` field over the party kind (500); test time travel corrected (no product defect).
- `pnpm audit --prod`: no known vulnerabilities.


### Phase 12 (2026-10-20)
- **API: 22 files / 456 tests passed** (was 340): booking domain unit tests (quotes, state machine, refunds, plates) and `booking.test.ts` (21 integration tests) plus `job-runner.test.ts`.
  - Real concurrency: 6 customers racing for 1 space → exactly 1 booking; 5 for 3 spaces → 3 on distinct units; 4 against a property cap of 2 → 2. Runs on a 5-connection pool, which also proves no pool deadlock.
  - Duplicate requests (parallel and sequential same key → one booking; reused key → 409; used quote → 409); stale quote, new host block and buffer gap refused at commit; expired, foreign and misfit quotes and vehicles; EV connector matching.
  - Lapsed holds: read as EXPIRED at once, don't block search or booking, expired in-transaction and by the job; late payment revives only if the space is free.
  - Host approve / decline / cancel and ownership; lapsed approval can't be approved; own listing refused.
  - Cancellation refunds from the snapshot (policy change after booking ignored), in-progress self-cancel refused; L-6 reveal and its 24-hour close; completion job; calendar and search see bookings.
- **E2E: 18/18** (mobile + desktop): new booking journey (sign in from listing → add vehicle → price → reserve → hold → cancel → bookings list); discovery now also hard-loads the listing page under the CSP.
- Lint, typecheck (all packages), Prettier: clean. web-kit 6/6. `pnpm audit --prod`: no known vulnerabilities.
- **Bugs found by tests and fixed:** pool deadlock from pool queries inside the booking transaction (D-096); parallel same-key retries returned 409 instead of the original booking; `next/image` inline style blocked by the CSP on server-rendered pages since Phase 10 (D-098); job events recorded `from_status` as null.
- Not run: GitHub Actions (no remote).


### Phase 11 (2026-10-20)
- **`pnpm check` exit 0:** lint and typecheck clean; **API 19 files / 340 tests passed** (was 314); web-kit 6/6; builds OK.
- **`pnpm e2e` exit 0: 16/16** (no regressions; search now runs on the engine).
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- **New unit tests (12, engine):**
  - Interval subtraction cases.
  - Local-time rules.
  - Asset-wide vs unit blocks, with block end exclusive.
  - OPEN exceptions, incl. merging with rules.
  - Block beats open.
  - Reservations: overlap vs adjacency (half-open).
  - **Buffers on both sides.**
  - Buffer past closing.
  - Asset-level reasons and free units.
  - Midnight-crossing rules with a reservation.
  - **DST** free time (Europe/London).
  - `maxConcurrent` (simultaneous, not total; half-open).
- **New integration tests (14, real DB):**
  - Window check reasons (CLOSED, DURATION, LEAD_TIME), unsupported mode 400, unknown 404.
  - Client UTC offsets evaluated in the property timezone.
  - Block → BLOCKED, end-exclusive, removed from windowed search, **reasons never public**.
  - Unit-scoped blocks on a 2-space lot.
  - Openings, and block beats opening.
  - Removal restores availability; owner-only.
  - Validation (inverted, past, unaligned seconds, > 366 days, foreign unit, other host).
  - Reservations via the seam: RESERVED and the 15-min buffer on both sides; **BR-04 block refused over a reservation**; multi-space allocation.
  - Calendar: free intervals per space in IST around a block and a reservation; range limit; ownership.
  - **Lock contract:** a block waits ≥ 650 ms while another session holds the asset row FOR SHARE (the booking side); 4 concurrent blocks serialise without deadlock.
- No defects found this phase. All new tests passed on first run after implementation.

### Phase 10 (2026-10-20)
- **`pnpm check` exit 0:** format, lint (incl. boundaries) and typecheck clean; **API 17 files / 314 tests passed** (was 274); web-kit 6/6; builds OK.
- **`pnpm e2e` exit 0: 16/16** (8 scenarios × mobile and desktop):
  - The new discovery journey:
    - seed a listing through the real host and admin flow;
    - search by place with booking type;
    - the card shows price and distance;
    - the listing page has the approximate-area notice, a loaded photo, monthly price, host first name and a disabled booking button;
    - the rendered HTML has no address, access PIN or surname;
    - no CSP violations.
  - Empty state with "widen".
  - 404 page.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- **New tests (40):**
  - Availability coverage (8): weekday, local-vs-UTC, midnight crossing incl. the previous day, merging, multi-day/monthly, validity dates, **DST (Europe/London)**, invalid windows.
  - Presentation and cursors (10).
  - Discovery integration (22):
    - Visibility and radius, with distances from the public point.
    - Paused, restricted-host and suspended listings hidden.
    - Each parking and EV filter.
    - Mode headline price, price sort.
    - Validation, pagination walk, cursor tampering and cross-query rejection.
    - Availability windows (weekday/weekend/evening, minimum duration, lead time, monthly continuity).
    - Detail precision, spaces and first name.
    - 404s.
    - **L-9:** no secret, exact coordinate or internal id in any response; exact field whitelist; views lack private columns.
    - Rate limit 61st → 429.
    - Places.
    - **`EXPLAIN` shows the GiST index is used through the view.**
- **Defects found and fixed during the phase:**
  1. **DATE columns** came back as local-midnight JS Dates and stringified wrongly ("Mon Oct 20 2026…"). This silently broke rule-validity comparisons and garbled `validFrom` in Phase 9 host views. Fixed at the driver level (D-080), with a regression test.
  2. Searches without a booking mode applied hourly min/max limits, hiding monthly-capable listings from long windows. Now limits apply only to hourly and charging modes.
  3. Public coordinates carried full precision. They're now rounded to ~110 m (D-075); with a north-only test offset, the exact longitude would otherwise appear verbatim.
  4. The per-IP OTP limit (20/h) was exhausted by the e2e suite from 127.0.0.1. It's now configurable (D-081).
  5. E2E harness: blocked requests count toward limits, so the helper honours Retry-After instead of polling; the Playwright API client won't send Secure cookies over http, so cookies are carried explicitly; numeric title suffixes were (correctly) rejected as phone numbers.

### Phase 9 (2026-10-20)
- **`pnpm check` exit 0:** format, lint (incl. module boundaries) and typecheck all clean; **API 14 files / 274 tests passed** (was 120); web-kit 6/6; builds OK.
- **`pnpm e2e` exit 0:** 10/10 (no regressions in sign-in journeys).
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- **New unit tests (124):**
  - The asset state machine: every status × action pair (54 cases), plus needs-review and archived cases.
  - The publish checklist.
  - Participation: every status pair (36 cases).
  - The fuzzed point: 500 samples per kind, plus determinism and geodesy.
  - Contact-detail detection: 9 blocked, 4 allowed.
  - Timezone validation, including `Asia/Kolkata`.
  - The photo pipeline: EXIF/GPS stripped, resize cap, SVG/GIF/tiny rejected, dHash robust to recompression and discriminating.
  - Storage key traversal rejection.
- **New integration tests (30, real DB):**
  - Host accounts: HOST role, idempotency, non-hosts refused, restricted hosts read-only.
  - Properties:
    - Encryption at rest and the fuzz range by kind.
    - The public point is stable on relabel and redrawn on move.
    - Service area, label, kind and timezone validation.
    - Cross-host 404.
    - Stale-version 409.
  - Listings:
    - Default space and checklist.
    - Contact-detail rejection.
    - No listing at someone else's property; cross-host read and write 404.
    - Optimistic concurrency.
    - Rates per type, units, overnight times, duplicates, minimum price, history.
    - Rule validation.
    - Unit deactivation.
    - EV requirements and wrong-type rejections.
  - Photos:
    - Stored object is WebP without EXIF; capture distance recorded.
    - Non-image, SVG, >10 MB, tiny and 11th photos rejected.
    - Cross-host near-duplicate flagged.
    - The full visibility matrix (anonymous, owner, other host, entrance, draft) with cache headers.
  - Lifecycle:
    - Submit gating; review queue hides access instructions; approve moderates photos; event history; reject needs a reason.
    - Pause and republish; material change while paused goes to review; archive rules; archived listings are immutable.
    - Moving the property sends listings to review.
    - Suspend and reinstate.
  - Societies:
    - Full consent lifecycle with an invalid-skip 409.
    - Member gating.
    - Participation suspension suspends listings.
    - Approval re-check after suspension.
    - Revoking one member affects only their listings.
  - Admin authz: SUPPORT 403, user 401, anonymous 401, SUPER_ADMIN 200.
- **Live smoke** against the running API with disk storage: become host, then commercial property, listing and GPS-tagged JPEG upload. The stored file is a 900×600 WebP with no EXIF/GPS strings. Owner fetch 200, anonymous fetch 404.
- **Defects found and fixed during the phase:**
  1. **Every property was rejected:** `Intl.supportedValuesOf('timeZone')` has no `Asia/Kolkata` (ICU uses `Asia/Calcutta`). Validation now uses `Intl.DateTimeFormat` (D-073), with a unit test.
  2. An admin approving a suspended listing got "not ready" (422) instead of "not allowed" (409). Transition validity is now checked before readiness, for host and admin actions.
  3. The schema was refined before first commit: phash `bytea` → `bigint` for SQL Hamming distance, and a `duplicate_suspected` flag (D-072).
  4. Typing and test-harness fixes: Kysely optional-property types, a sharp type import, synthetic test photos that differed only in fine detail (a perceptual hash correctly ignores that).

### Phase 8 (2026-10-20, Node 24.22, PostgreSQL 17.5 + PostGIS 3.5, Chromium 153)
- **`pnpm check` exit 0:** format clean; lint clean (0 warnings); typecheck clean in 7 packages; **API 11 files / 120 tests passed**; web-kit 6/6 passed; builds OK.
- **`pnpm e2e` exit 0: 10/10 passed** (5 scenarios × mobile and desktop Chrome, production builds):
  - Sign-up with a wrong-code error, consent gating, cookie attributes, profile persistence across reload, sign-out and redirect.
  - Strict nonce CSP: no `unsafe-inline` or `unsafe-eval`, and the nonce changes per request.
  - Invalid-number error.
  - Open-redirect guard.
  - Admin OTP + TOTP sign-in with a wrong-code error, permissions shown, admin cookie, sign-out.
  - No CSP violations or page errors in any browser test.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- Integration coverage (real DB):
  - Enumeration-safe OTP request.
  - Normalisation.
  - Per-number and per-IP rate limits with `Retry-After`.
  - Wrong-code counting and lock.
  - Expiry, supersede, reuse.
  - Malformed input.
  - Registration: cookie flags, role, consents, audit.
  - Phone encrypted at rest.
  - Age and notice-version gating, display-name validation.
  - Reused, expired and tampered tickets.
  - Concurrent ticket use creates one account; concurrent two-device registration creates one account.
  - Sign-in, logout, idle and absolute expiry, sliding capped by absolute.
  - Suspension.
  - Device list and revoke, with 404 for another user's session.
  - Profile update, validation and auth.
  - Customer → host-only route 403.
  - Admin: non-admin refused; full OTP + TOTP flow; regrant without re-enrolment; cookie isolation both ways; TOTP replay rejected; role removal ends the admin session; TOTP lock after 5; admin logout; audit actions.
  - No phone, OTP or token in logs.
  - No raw IP in rate-limit keys.
  - Rate limiter: exact counting under 30 concurrent hits, longest-wait enforcement, key independence, retention purge.
- Unit coverage:
  - TOTP RFC 6238 vectors, replay and window.
  - Phone normalisation (12 cases).
  - AES-GCM round-trip, tamper, context binding, key rotation.
  - Keyed hash.
  - UUIDv7.
  - Env: dev-key refusal, no production OTP provider, formats.
- **Manual end-to-end** through the web origin with curl: nonce on all 12 script tags, sign-up, `__Host-` cookie, `/me`, logout → 401, no phone in API logs.
- **Defects found and fixed during the phase:**
  1. A tautological CHECK constraint on `otp_challenges` (it enforced nothing) was replaced with the real invariant.
  2. `phone_hmac` NOT NULL conflicted with the anonymisation design. It's now nullable only for CLOSED users.
  3. **Privacy:** raw client IPs were in rate-limit keys. They're now keyed hashes, with a regression test.
  4. Rate-limit and OTP tables had no cleanup. Bounded opportunistic purge added until Phase 12 jobs (D-059).
  5. Copy: "Please wait 1 seconds" → correct pluralisation.
  6. UX: an unchecked Terms box produced a misleading "terms updated" error. There are now specific client-side messages, and the server still enforces both.
  7. Kysely typing (transaction executor, table registries as type aliases), `packages/config` missing DOM lib.
  8. Test-harness issues (resend window between steps, colliding parallel phone numbers, Playwright hiding Secure cookies for `http://` URLs, the Next route announcer matching `role=alert`). None were product defects.
- Not run: GitHub Actions (no remote yet).

### Earlier phases
- **Phase 7:** 52 tests plus the manual same-origin proxy check.
- **Phase 6:** db-prototype, 18 PASS (`docs/db-prototype/run-checks.sh`).
- **Phases 1–5:** documentation coverage checks.

### Phase acceptance
| Phase | Result | Evidence |
|---|---|---|
| **23: Production Hardening & Launch** | **Met.** Security (authentication, authorization, secrets, PII, location privacy, payment security, webhooks, rate limiting, abuse, injection, data access), reliability, performance, UX, testing and observability reviewed (`production-readiness.md`, `final-qa.md`); the full suite runs green; critical issues fixed (address-reveal audit, pilot clearance, data-rights requests, alerting, route inventory) without architectural rewrites; pilot launch plan prepared (`launch-checklist.md` §4); final report below. | Test results above, D-168 to D-171 |
| **22: AI Layer** | **Met (live model pending a key).** Prioritised by user problem: natural-language parking and EV search built; other eight candidates assessed and deferred with reasons. Architecture user → LLM → structured intent → validation → authorisation (public search only) → application tool (geocoder → regular search) → deterministic logic → result; AI never mutates state and never states availability, price, booking, payment, payout, authorisation or access. Model, cost, latencies, errors, tool calls, evaluation and fallback tracked; `docs/ai-strategy.md` created. | Test results above, D-163 to D-167 |
| **21: Analytics & Marketplace Intelligence** | **Met.** Supply (hosts, assets, parking and charger inventory, availability as open unit-hours, utilisation), demand (customers, searches, conversion, repeat bookings) and marketplace (GMV, revenue, commission, average booking value, cancellation, no-show, utilisation, retention) metrics, liquidity first (zero-result rate, liquidity by area, playbook); `docs/analytics.md` created. | Test results above, D-159 to D-162 |
| **20: Admin Platform** | **Met.** Users, hosts, properties, assets, bookings, payments, payouts, reviews, disputes, verification (payout accounts, listing review), fraud indicators, configuration (read-only), with search, filters, pagination, detail views and audit logs; every admin action requires authorization (permission per endpoint) and a recorded reason. | Test results above, D-154 to D-158 |
| **19: Reviews, Trust & Disputes** | **Met.** Customer and host reviews, ratings, trust signals, disputes with evidence and states, admin resolution with audit logs; all nine listed cases are categories; no automatic (or AI) resolution of any dispute, HIGH risk only by trust & safety. Admin UI is Phase 20. | Test results above, D-148 to D-153 |
| **18: Notifications** | **Met (vendors pending).** Events: confirmation, reminder, start, end, charging start/completion, cancellation, refund, payment, payout, verification (payout account), issue alerts; dispute template ready for Phase 19. Provider abstraction for push/email/SMS/WhatsApp, retries, duplicate prevention, delivery status tracking. Real SMS/WhatsApp vendors need owner registration (R-77). | Test results above, D-143 to D-147 |
| **17: Access Management** | **Met.** Access abstraction with code (OTP-style 6-digit), digital pass, vehicle number and security (guard) verification; interfaces for smart locks, ANPR, gate and society systems; access only from a valid booking; every access event logged; access information protected (hashed/encrypted, minimal guard answers, owner-only logs). QR rendering deferred (pass token ready, D-137). | Test results above, D-136 to D-142 |
| **16: Host Earnings & Payouts** | **Met.** Customer payment, platform commission, fees/taxes, host earnings and payout are separate ledger accounts; hosts see gross, fees, commission, net, pending and completed (paid). Ledger and reconciliation foundations (balanced journals, trial balance, backfill). No complex banking: manual payouts with UTR. | Test results above, D-128 to D-135 |
| **15: Payments** | **Met (sandbox verification pending).** Initiation, confirmation, webhooks, signature verification, idempotency, payment states, failed payments, refund architecture, reconciliation; frontend success never trusted. Required tests (success, failure, duplicate webhook, delayed webhook, refund, mismatch) all automated. Provider = Razorpay adapter + simulator; a live sandbox run needs owner keys (R-68). | Test results above, D-120 to D-127 |
| **14: EV Charging Experience** | **Met.** Charger details, connector compatibility, power, AC/DC, pricing (hour / session), availability (generic engine), charging-session model, parking + charging relationship (bay + charger, D-119). No live hardware assumed; clean `ChargerIntegration` interface for smart chargers. | Test results above, D-114 to D-119 |
| **13: Parking Experience** | **Met.** Parking listing, photos, details, rules, availability (UI on the generic engines); hourly, daily, overnight booking; monthly booking architecture (series, renewals, notice, grace) built and tested; recurring architecture (cadence seam) designed. Customer Search → Select → Check → Book and host Create → Publish → Receive → Manage both covered end to end in e2e. Payments remain Phase 15 (holds only). | Test results above, D-104 to D-113 |
| **12: Booking Engine** | **Met.** Customer selects asset, date and time, checks availability (server quote), books, views and cancels. Explicit states (pure state machine + DB CHECKs). Protected against double booking (exclusion constraint + unit retry), race conditions (lock order, cap lock, real concurrency tests), duplicate requests (Idempotency-Key + unique key + quote lock), stale availability (re-check inside the transaction; lapsed holds). Transactions, constraints, locks and idempotency used. Payments are Phase 15, so bookings are holds (D-092). | Test results above, `docs/api-design.md`, `docs/database-design.md` §6.6 |
| **11: Availability Engine** | **Met.** Availability windows, recurring availability, exceptions, blocks, booking-based unavailability (through the reservation seam, real bookings in Phase 12). Handles overlapping and adjacent bookings, time boundaries, time zones, blocked periods, and concurrent access (lock contract tested). Deterministic application state only; no AI involvement. | Test results above |
| **10: Location & Discovery** | **Met.** Search, search nearby (place or device location), filter (parking: price, distance/radius, covered, security, EV-ready, duration/mode, availability window; EV: connector, power, AC/DC, price, distance, availability), sort, paginate, view listings. Exact residential location protected (views, fuzzed point, rounding, L-9 tests). Indexes reviewed with EXPLAIN. Availability is coarse (weekly rules) until Phase 11, as planned. | Test results above, `docs/api-design.md` |
| **9: Property & Asset Management** | **Met.** Generic Property → Asset → AssetType with PARKING and EV_CHARGING. Parking information (location, photos, dimensions, vehicle class, covered/open, security, CCTV, rules, EV-ready) and EV charger information (connector, AC/DC, power, pricing, parking bay, access instructions). Create, update, publish (submit + review), unpublish (pause), archive. Only owners and authorised society member hosts may modify (tested). Speed is derived from power for now; a charging-speed field comes in Phase 14. | Test results above, `docs/api-design.md` |
| **8: Identity & Authorization** | **Met.** Registration, login, logout, session handling (sliding and absolute expiry, revocation), user profile, the four roles, server-side authorisation (roles, admin permissions, ownership). Tested: authentication, invalid, expired and revoked credentials, unauthorised access, role access, resource ownership. No KYC built (as required). | Test results above, `docs/api-design.md` |
| 7: Foundation | Met | Phase 7 results |
| 0–6: Design | Met | docs/ |

## KNOWN ISSUES
- Code is on GitHub (`github.com/riiken/ParkBro`, branch `main`); CI runs there. Never `git add` ParkBro from the parent `/Users/riiken/Documents` repo.
- **Production start-up is refused by design** until a DLT-registered OTP/messaging provider, a maps geocoder and live Razorpay keys exist (launch-checklist B2–B4).
- Locally, web (4100/4110) and admin (4102/4112) share host `127.0.0.1`, so they share a cookie jar. Cookie-to-surface isolation is enforced by the API (tested). Full origin separation comes with real subdomains.
- The PostGIS image is amd64-only (emulated on Apple Silicon, R-49).
- Terms and Privacy pages are drafts pending legal review (consent version `pilot-2026-10`).
- Payments run on the simulator until Razorpay keys exist; the adapter is untested against the live sandbox (R-68).
- Maps run on free OpenStreetMap services (Photon search, OpenFreeMap tiles; D-174, R-90). Fine for the pilot; self-host or move to a paid provider as traffic grows.
- ID and vehicle RC verification are manual (pilot clearance) until KYC providers are chosen (R-62, R-72).

## TECHNICAL DEBT
| Item | Why deferred | Resolve |
|---|---|---|
| Automated erasure and self-service data export (D-169) | Runbook suffices for an invite-only pilot | Before open sign-up |
| KYC providers replacing pilot clearance (R-62, R-72) | Vendors not chosen | Before open sign-up |
| Parallel test for per-host payout/refund serialisation (D-134) | Advisory lock implemented, not yet race-tested | Next engineering cycle |
| Database role split (app / migrator / read-only analytics) | Needs the production database | Launch (B10) |
| Field keys from env, not KMS-wrapped (AR-1) | Cloud choice open | Launch (B5) |
| Deployment (containers, IaC, backups/PITR) | Cloud choice open | Launch (B5, B13) |
| Removed photo objects stay in storage | Retention rules need counsel input | After launch |
| Booking list N+1 reads (R-60); admin offset pagination (R-81); analytics rollups (R-82) | Pilot volumes | When p95 exceeds SLO |
| Local-disk photo storage (R-57) | Cloud choice open | Launch (B5) |
| QR rendering of the pass (D-137) | Needs a QR encoder dependency | When guards ask for scanning |
| Real access adapters (smart lock, ANPR, MyGate/NoBrokerHood) and smart-charger adapter (R-66) | No partner/hardware yet | Per partner |
| Weekday-recurring series (D-109); shareable search URLs (D-113) | Not in the pilot | Later |
| Search candidate cap of 500 + in-app availability filter (D-077) | Pilot scale | When p95 > SLO or the cap is reached |
| Email (V-EMAIL), web push (R-78) | No provider / need yet | Later |
| Admin lost-authenticator recovery; admin grants only via CLI (R-53) | Small admin team | After launch |
| Automated payouts (RazorpayX) and penny-drop verification | Manual for the pilot (D-132, D-133) | When volume justifies |
| Live AI model (R-84) | Key, DPA, eval run | When the owner enables it |
| CI secret scanning | Needs a remote | With the remote (B9) |
| TypeScript 7 | typescript-eslint support | When supported |

## IMPORTANT DECISIONS
Full list in `docs/decision-log.md` (D-001 to D-171). Key ones:
- **Launch:** pilot clearance (D-168); data-rights requests (D-169); ops alerting + route inventory (D-170); pilot plan (D-171, proposed).
- **AI:** provider seam and default model (D-163); filters-only intent with strict schema (D-164); rules fallback and budget (D-165); privacy (D-166); prioritisation and eval bar (D-167).
- **Analytics:** anonymous discovery signals only (D-159); metrics read from the systems of record, money from the ledger (D-160); definitions and retention (D-161); no third-party analytics or warehouse (D-162).
- **Admin:** console on its own origin (D-154); module-owned admin lists (D-155); permission + reason + audit for every action (D-156).
- **Trust:** blind two-sided reviews (D-148); trust signals (D-149); disputes with evidence (D-150); human-only resolution, HIGH risk by trust & safety (D-151); dispute earnings hold (D-152).
- **Notifications:** outbox rows from events with dedupe keys (D-143); channel policy (D-144); delivery worker and receipts (D-145); no personal data in messages (D-146).
- **Access:** grants from confirmed bookings (D-136); code/plate/pass mechanisms (D-137); guard links (D-138); host-reported no-show (D-139); 15-minute recourse refund (D-140); adapter seam (D-141).
- **Earnings:** double-entry ledger (D-128); split rules (D-129); postings in the payment transaction, receivables (D-130); 48 h release (D-131); manual payouts (D-132); payout accounts (D-133).
- **Payments:** provider seam with Razorpay + simulator (D-120); verified-only success (D-121); single success path with mismatch quarantine and automatic refunds (D-122); webhook dedupe lease (D-123); refund pipeline (D-124); reconciliation (D-125).
- **EV:** charging module and sessions (D-114); charger integration seam (D-115); session rules (D-116); time-based pricing, energy as estimate (D-117).
- **Parking experience:** monthly as booking series (D-104, D-105); notice and termination rules (D-106); pause vs. suspension for renewals (D-107); series-first lock order (D-108); hosting mode in the web app (D-111).
- **Booking:** holds until payments (D-092); confirmation only from verified payment events (D-093); single-use quotes (D-094); idempotency (D-095); all transaction queries on the transaction (D-096); pg-boss jobs (D-097); no self-booking, no self-cancel in progress (D-100).
- **Product:** generic asset marketplace (D-001); pilot wedge, proposed and needing the product owner (D-009); low host commission + customer fee (D-010).
- **Domain:** unit-based inventory (D-012); one space = one asset (D-013); monthly as a series of bookings (D-014); separate state machines (D-015); paise and double-entry ledger (D-016); recourse entity (D-019).
- **Trust:** risk-based verification (D-024); KYC results only (D-025); location privacy (D-026); no implied insurance (D-027).
- **Architecture:** stack (D-031); module rules (D-032); same-origin `__Host-` sessions (D-033); no Redis at pilot (D-034).
- **Database:** exclusion-constraint double-booking guard (D-040); in-transaction lapsed holds (D-041); property-cap lock (D-042).
- **Foundation:** native TypeScript (D-047); own migration runner (D-049); route-pattern logging (D-051).
- **Availability:** pure engine as single source (D-084); `ReservationSource` seam (D-085); block FOR UPDATE / booking FOR SHARE lock contract (D-086).
- **Discovery:** view-only reads (D-074); ~110 m public coordinates (D-075); timezone-correct coarse availability (D-076); candidate cap + query-bound cursors (D-077); fixture geocoder (D-078).
- **Listings:** API-first Phase 9 (D-063); minimal availability, pricing and trust foundations (D-064); in-process domain events (D-065); admin-onboarded societies with member hosts (D-067); photo pipeline (D-068); human review of everything in the pilot (D-069).
- **Identity:** enumeration-safe OTP with registration tickets (D-054); session lifetimes (D-055); admin TOTP + CLI bootstrap (D-056); refuse production without a real OTP provider or with dev keys (D-057); hashed rate-limit keys (D-058); nonce CSP (D-060); production-build e2e (D-062).

## BLOCKERS
No engineering blocker remains in the code. **Launch blockers are owner actions and external dependencies** (launch-checklist §1: entity/brand, DLT/WhatsApp, Razorpay live + sandbox run, maps vendor, cloud + secrets, counsel/CA, git remote). A live AI model additionally needs a key, a provider DPA and a passing `pnpm ai:eval` (R-84). Production messaging needs DLT/WhatsApp registration (owner action, R-46, R-77). Live payments need Razorpay keys and a sandbox run (owner action, R-68). Owner actions and decisions outstanding:
1. **Razorpay account and keys** (test and live) to run the sandbox checklist (R-68).
1. **Git remote and first commit.** Needed for CI. Nothing has been committed, because the owner hasn't asked.
2. **Pilot decisions:** confirm or adjust D-009, the pilot city and neighbourhoods, 2W/3W scope, and brand (UX-2, AR-5).
3. **Start TRAI DLT SMS and WhatsApp template registration**, which needs a legal entity and brand. Production sign-in depends on it (R-46, D-057).
4. **Counsel and CA before launch:** Terms and Privacy text (drafts are live in the app), liability (D-027), DPDP, GST/TCS/TDS, payment aggregator.
5. Open questions with working defaults: Q-1 to Q-6, UX-1 to UX-4, TS-1 to TS-5, AR-1 to AR-5, DB-1 to DB-3.

## FINAL REPORT (Phase 23)

### 1. Production-ready functionality
Identity (OTP, sessions, roles, admin TOTP); properties and listings for parking and EV with photos and human review; privacy-safe discovery with filters and natural-language search; availability engine; booking (hourly, daily, overnight, monthly series, charging sessions, approvals, policy-based cancellation) with concurrency safety; payments with verified-only confirmation, refunds and reconciliation; double-entry ledger, earnings and manual payouts; access (code, plate, driver pass, guard links, ANPR ingestion, 15-minute recourse refund); notifications outbox and in-app inbox; blind two-sided reviews, trust signals, disputes with human resolution; admin console for every entity with audit; analytics and liquidity; AI search with fallback and tracking; pilot clearance; data-rights requests; ops alerting. Details: `docs/production-readiness.md` §7.

### 2. Non-production-ready functionality
OTP/messaging vendor, maps geocoder and map UI, live payments (sandbox run), deployment/backups/KMS, legal texts, KYC providers, live AI model, automated erasure/export, web push/email, QR pass, hardware integrations. Details: `docs/production-readiness.md` §8.

### 3. Known risks
Top open risks: R-01 liquidity (cold start), R-46/R-77 messaging registration, R-68 live payments, R-86 external lead times, R-87 on-call coverage, R-62/R-72 manual verification, R-84 AI provider DPA. Full list: `docs/risk-register.md`.

### 4. Technical debt
See TECHNICAL DEBT above; nothing there blocks a controlled pilot except the launch items marked B5/B10/B13.

### 5. Operational requirements
Trust & safety and support staffed 07:00–23:00 IST during the pilot with an on-call phone for gate issues; finance weekly payout run (Monday) and refund/reconciliation checks; trust & safety clears customers (RC/ID call), reviews every listing, handles disputes and data requests within due dates; runbooks in `docs/production-readiness.md` §6.

### 6. Monitoring requirements
Uptime checks on `/api/health/ready` and `/api/health/ops` (bearer token; page on 503), log shipping with error-rate alerts, the 16 ops checks and thresholds (`docs/production-readiness.md` §5.1), weekly review of Analytics (liquidity, booking success, cancellations, no-shows, disputes, revenue, AI fallbacks).

### 7. Pilot recommendation
Bengaluru; 2–3 adjacent neighbourhoods (e.g. Koramangala, HSR Layout, BTM Layout); 20–40 hand-recruited hosts; 50–100 spaces and 5–15 AC chargers; invite-only, cleared customers (200–400); 8–12 weeks; expand only after four consecutive weeks of zero-result rate < 30 %, booking success ≥ 70 %, recourse refunds < 5 %, no high-risk dispute older than 7 days and no critical alert over 1 hour. `docs/launch-checklist.md` §4 (D-171, needs owner confirmation).

### 8. Next priorities
1. Owner actions B1–B9 (entity, DLT/WhatsApp, Razorpay, maps, cloud, counsel/CA, git remote).
2. Engineering on arrival: OTP/messaging, geocoder/map and deployment adapters; Razorpay sandbox run; database roles; monitoring wiring; restore drill.
3. Pilot operations rehearsal (runbooks) and host recruitment in the pilot neighbourhoods (supply before demand, R-01).
4. Post-launch: KYC providers, automated erasure/export, payout/refund race test, then expansion per the pilot gates.

## NEXT PHASE
**None — all phases in PHASES.md are complete.** Next work is the launch checklist (`docs/launch-checklist.md` §1) and the pilot itself.
