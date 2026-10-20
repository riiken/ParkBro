# API Design

Living reference for API conventions and endpoints. Created in Phase 8, when the first real endpoints shipped. The machine-readable contract is the generated OpenAPI 3.1 document at `GET /api/docs/openapi.json` (non-production). This file explains the rules behind it.

Related: [architecture.md §6](architecture.md#6-key-flows), [trust-and-safety.md](trust-and-safety.md), [domain-model.md §4](domain-model.md#4-ownership-and-authorisation).

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Base path | Every endpoint is under `/api`, same-origin on each web origin (D-033). Versioned public endpoints are under `/api/v1`. Admin endpoints are under `/api/admin` (admin origin and cookie only). |
| Format | JSON request and response bodies. Timestamps are ISO-8601 UTC strings. Money is integer paise (later phases). |
| Validation | Zod schemas on params, query and body. Unknown body fields are rejected where mass assignment would matter (for example `PATCH /v1/me` is `.strict()`). |
| Response shaping | Every success response has a schema. Undeclared fields are stripped, and a response that violates its schema becomes a 500. This is the main defence against data leaks. |
| Errors | RFC 9457 `application/problem+json`: `type`, `title`, `status`, `code` (stable, machine-readable), optional `detail` (user-safe), `requestId`, and `errors[]` for field errors (`path` like `body/displayName`). Clients branch on `code`, never on `title`. |
| Status codes | 200/201/202/204 success. 400 invalid or business-rule input. 401 no valid session. 403 not allowed. 404 not found, which is also used for other users' resources. 409 conflict. 413 too large. 429 rate limited (with `Retry-After`). 503 dependency unavailable. |
| CSRF | Every POST, PUT, PATCH and DELETE needs the header `X-Requested-With: fetch`. Only signed provider webhooks opt out. |
| Auth | Opaque session in a `__Host-` cookie (`__Host-pb_session` for users, `__Host-pb_admin` for admins). Never bearer tokens in URLs. |
| Request IDs | `X-Request-Id` is echoed on every response and included in problem bodies for support. |
| Caching | `Cache-Control: no-store` unless a route explicitly opts in. |
| Rate limits | Postgres-backed fixed windows. Keys never contain raw PII (phone and IP are keyed hashes). |

---

## 2. Error codes (identity)

| Code | Status | Meaning, and what the UI does |
|---|---|---|
| `auth.phone_invalid` | 400 | Not a valid Indian mobile number. Show it on the phone field. |
| `auth.otp_incorrect` | 400 | Wrong code. `detail` says how many attempts are left. |
| `auth.otp_expired` | 400 | The code is expired, used, superseded or locked. Offer to resend. |
| `auth.ticket_invalid` | 400 | The registration or TOTP step expired or was already used. Restart sign-in. |
| `auth.notice_outdated` | 400 | Terms changed since the page loaded. Re-show the notice. |
| `auth.account_suspended` | 403 | Show the support contact. |
| `auth.not_admin` | 403 | The admin origin was used by a non-admin. |
| `auth.totp_incorrect` | 400 | Wrong or reused authenticator code. |
| `auth.otp_delivery_failed` | 503 | SMS or WhatsApp provider failure. Retry. |
| `auth.unauthenticated` | 401 | Sign in (preserve `?next=`). |
| `auth.forbidden` | 403 | The role or permission is missing. |
| `request.invalid` | 400 | Field errors in `errors[]`. |
| `request.rate_limited` | 429 | Wait `Retry-After` seconds. |
| `request.csrf_header_missing` | 403 | Client bug. |
| `conflict.stale` | 409 | Someone else changed it: reload and retry (optimistic concurrency). |
| `host.not_a_host` / `host.restricted` / `host.already_host` | 403 / 403 / 409 | Host account state. |
| `property.outside_service_area` / `property.invalid_timezone` / `property.transition_not_allowed` | 400 / 400 / 409 | Property validation. |
| `asset.property_unavailable` / `asset.wrong_type` / `asset.not_ready` / `asset.transition_not_allowed` / `asset.archived` | 400 / 400 / 422 / 409 / 409 | Listing rules. |
| `media.unsupported` / `media.too_small` / `media.limit_reached` | 415 / 400 / 409 | Photo rules. |

---

## 3. Identity endpoints (Phase 8)

### Customer / host (`/api/v1`)

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /v1/auth/notice` | none | The current Terms and Privacy notice version |
| `POST /v1/auth/otp/request` `{phone}` | none | Send an OTP. **202** `{challengeId, expiresAt, resendAfterSeconds}`. The response is identical for registered and unregistered numbers. |
| `POST /v1/auth/otp/verify` `{challengeId, code}` | none | Either `AUTHENTICATED` (sets the session cookie, returns the profile) or `REGISTRATION_REQUIRED` `{ticket, ticketExpiresAt}` |
| `POST /v1/auth/register` `{ticket, displayName, ageAttested: true, acceptedNoticeVersion}` | ticket | Create the account (CUSTOMER role, consent records), set the session cookie. **201**. |
| `POST /v1/auth/logout` | optional | Revoke the current session and clear the cookie. **204** (idempotent). |
| `GET /v1/me` | user | Profile `{id, displayName, phoneMasked, locale, roles, createdAt}` |
| `PATCH /v1/me` `{displayName?, locale?}` | user | Update the profile (audited with field names only) |
| `GET /v1/me/sessions` | user | The user's signed-in devices, with `current` flagged |
| `DELETE /v1/me/sessions/{id}` | user | Revoke one of the user's own sessions. Someone else's session returns **404**. |

### Admin (`/api/admin`, admin origin)

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /admin/auth/otp/request` `{phone}` | none | As above, with the admin purpose |
| `POST /admin/auth/otp/verify` `{challengeId, code}` | none | `TOTP_REQUIRED` `{ticket}` for active platform admins with MFA, otherwise `auth.not_admin` |
| `POST /admin/auth/totp` `{ticket, code}` | ticket | Verify the RFC 6238 code (±1 step, no replay). Sets `__Host-pb_admin` and returns the admin profile with permissions. |
| `POST /admin/auth/logout` | optional | Revoke the admin session |
| `GET /admin/me` | admin session + any permission | The admin's profile and permissions |

Admin bootstrap (until the admin console exists, Phase 20): `pnpm --filter @parkbro/api admin:grant <phone> <PERMISSION,...>`. The user must have registered first. On the first grant the command enrols TOTP and prints the `otpauth://` URI **once**.

### Host listings (Phase 9, `/api/v1/host`)

| Method and path | Purpose |
|---|---|
| `POST /v1/host/account` `{kind, displayName}` · `GET /v1/host/account` | Become a host (grants HOST) · view host account |
| `POST /v1/host/properties` · `GET /v1/host/properties` · `GET/PATCH /v1/host/properties/{id}` | Houses, commercial, office, other (societies are admin-created). Responses include the exact location (owner only) and the public fuzzed point. PATCH needs `version`. |
| `POST /v1/host/assets` · `GET /v1/host/assets` · `GET/PATCH /v1/host/assets/{id}` | Listings (PARKING, EV_CHARGING) with a publish `checklist`. PATCH needs `version`. |
| `PUT …/parking-details` · `PUT …/charger-details` · `PUT …/units` · `PUT …/rates` · `PUT …/availability-rules` | Replace each part of a listing |
| `POST …/attestations` `{kind, accepted: true}` | RIGHT_TO_RENT, CHARGER_SAFETY (wording returned in the listing view) |
| `POST …/media?kind=SLOT\|ENTRANCE\|CHARGER\|OTHER[&lat&lng]` (raw JPEG/PNG/WebP body, ≤ 10 MB) · `DELETE …/media/{mediaId}` | Photos (max 10; re-encoded, metadata stripped) |
| `POST …/availability-exceptions` `{kind: BLOCK\|OPEN, start, end, unitId?, reason?}` · `DELETE …/availability-exceptions/{id}` | Host blocks and extra openings (whole minutes, future, ≤ 366 days). A BLOCK overlapping a booking (incl. its buffer) is 409 `availability.block_conflicts_booking`. |
| `GET …/calendar?from&to` (≤ 62 days) | Free time per space in the property timezone, with blocks/openings (with reasons) and reservations |
| `POST …/submit` · `…/pause` · `…/republish` · `…/archive` | Lifecycle (domain-model §5.1). 422 `asset.not_ready` lists missing items; 409 `asset.transition_not_allowed`. |
| `GET /v1/media/{mediaId}` | Photo: owner always; others only approved, non-entrance photos of published listings (else 404) |

### Listing review and societies (Phase 9, `/api/admin`, TRUST_SAFETY)

| Method and path | Purpose |
|---|---|
| `GET /admin/review/assets` · `GET /admin/assets/{id}` · `GET /admin/media/{id}` | Review queue (with duplicate flags and capture distances) |
| `POST /admin/assets/{id}/approve\|reject\|suspend\|reinstate` `{reason}` | Review and enforcement (reason required except approve) |
| `POST /admin/properties/societies` · `GET /admin/properties/{id}` | Onboard a society (starts CONSENT_REQUIRED) |
| `POST /admin/properties/{id}/participation` `{status, reason}` | Participation transitions (§5.2, D-066); SUSPENDED/WITHDRAWN suspend its listings |
| `POST /admin/properties/{id}/member-hosts` `{hostAccountId}` · `DELETE …/member-hosts/{hostAccountId}` | Approve / revoke resident hosts (revocation suspends their listings there) |

### Discovery (Phase 10, public, anonymous, rate-limited per IP)

| Method and path | Purpose |
|---|---|
| `GET /v1/listings/search?lat&lng&type=PARKING\|EV_CHARGING[&radiusM≤10000][&mode][&start&end][&maxPricePaise][&covered][&security=CCTV,GUARD,GATED][&evReady][&vehicleClass][&connectors][&currentType][&minPowerKw][&sort=distance\|price][&cursor][&limit≤50]` | Nearby published listings: rounded distance from the fuzzed point, headline price (requested mode, else hourly → daily → overnight → monthly), first public photo, badges. `availabilityChecked` is true when a window was given (weekly rules + lead time; exact availability in Phase 11). Price sort and `maxPricePaise` need `mode`. 60/min per IP. |
| `GET /v1/listings/{id}[?lat&lng]` | Public listing view: area label, approximate location (`AREA` 500 m circle or `PIN` for commercial), rounded coordinates, host first name, public photos, all rates, weekly schedule, booking terms. Never exact address or access details. 120/min per IP. |
| `GET /v1/listings/{id}/availability?start&end[&mode]` | Deterministic window check (Phase 11 engine): `{available: true}` or `{available: false, reason: CLOSED\|BLOCKED\|RESERVED\|NO_UNITS\|INVALID_WINDOW\|LEAD_TIME\|DURATION}`. 400 if the listing doesn't offer `mode`. |
| `GET /v1/places/autocomplete?q=` · `GET /v1/places/{placeId}` | Place search for "where?" (fixture geocoder until AR-3). 120/min per IP. |

New error codes: `discovery.invalid_cursor` (400): the page link belongs to a different or expired search. `availability.invalid_window`, `availability.unknown_unit` (400), `availability.block_conflicts_booking` (409).

### Vehicles and bookings (Phase 12, customer, `/api/v1`)

| Method and path | Purpose |
|---|---|
| `GET /v1/me/vehicles` · `POST /v1/me/vehicles` `{plate, vehicleClass, isEv, connectors, nickname}` · `DELETE /v1/me/vehicles/{id}` | Up to 5 vehicles. Plates normalised (state and BH series), encrypted at rest, unique among active vehicles |
| `POST /v1/quotes` `{assetId, mode, start, end}` | Server-priced, availability-checked quote: lines, total, cancellation-policy snapshot, `expiresAt` (15 min), `approvalRequired`. 120/h per customer |
| `POST /v1/bookings` `{quoteId, vehicleId}` + header **`Idempotency-Key`** (8–100 of `[A-Za-z0-9_-]`) | Creates a hold (201). Same key again → the same booking (200). Re-checks availability, the cap and vehicle fit at commit. 20/h per customer |
| `GET /v1/bookings` · `GET /v1/bookings/{id}` | The customer's own bookings (others' → 404). Lapsed holds read as `EXPIRED`. `access` (exact address, space label, instructions) only for `CONFIRMED`/`IN_PROGRESS` until end + 24 h (L-6). `cancellation.refundIfCancelledNowPaise` is the preview |
| `POST /v1/bookings/{id}/cancel` `{reason?}` | Customer cancellation; refund from the booking's policy snapshot (0 if unpaid). Not from `IN_PROGRESS` |

### Host bookings (Phase 12, `/api/v1/host`)

| Method and path | Purpose |
|---|---|
| `GET /v1/host/bookings` · `GET /v1/host/bookings/{id}` | The host account's bookings: customer "First L.", plate (masked 30 days after the end), space label |
| `POST /v1/host/bookings/{id}/approve` · `…/decline` `{reason?}` | Approval listings; approve starts a 10-minute payment hold. Not after the approval window lapsed |
| `POST /v1/host/bookings/{id}/cancel` `{reason}` (5–300 chars) | Host cancellation, full refund to the customer |

### Monthly plans (Phase 13, booking series)

| Method and path | Purpose |
|---|---|
| `GET /v1/series` · `GET /v1/series/{id}` | The customer's monthly plans: status (`REQUESTED`, `ACTIVE`, `PAST_DUE`, `NOTICE_GIVEN`, `ENDED` + `endedReason`), anchor, price per month, notice and grace days, `endsAt`, `nextRenewal`, periods (booking id, status, window, `payBy`). No space label or host-only fields |
| `POST /v1/series/{id}/notice` | Customer notice: ends at the first period boundary ≥ 15 days away; later reserved periods cancelled (refunded if paid) |
| `GET /v1/host/series` · `GET /v1/host/series/{id}` · `POST /v1/host/series/{id}/notice` | Same for the host, plus customer "First L." and space label |

A `MONTHLY` quote must cover exactly one calendar month from the start (BR-13) and the schedule must be open for all of it (24/7). `POST /v1/bookings` with a monthly quote returns period 1 as `AWAITING_HOST_APPROVAL` with `series: {id, periodIndex: 1}`. Booking views carry `series` and `cancellation.cancellable`. New error codes: `booking.series_use_notice` (409), `series.transition_not_allowed` (409), `asset.has_upcoming_bookings` (409).

### EV charging sessions (Phase 14)

| Method and path | Purpose |
|---|---|
| `GET /v1/bookings/{id}/charging` | Session for the customer's EV booking: status (`NOT_STARTED`, `CHARGING`, `COMPLETED`, `STOPPED_EARLY`, `FAULTED`), charger (connectors, AC/DC, kW, speed class, cable, integration), start/end, energy (null without metering), planning bound, fault, allowed actions |
| `POST /v1/bookings/{id}/charging/start` · `…/stop` | Self-reported start (15 min before start → end) and stop, through the charger integration |
| `POST /v1/bookings/{id}/charging/fault` `{reason, note?}` | NOT_WORKING, CONNECTOR_DAMAGED, NO_POWER, CANNOT_REACH, OTHER |
| `GET /v1/host/bookings/{id}/charging` | Host read-only view |

Error codes: `charging.not_an_ev_booking`, `charging.booking_not_active`, `charging.outside_window`, `charging.transition_not_allowed` (409), `charging.charger_refused` (502).

### Payments (Phase 15)

| Method and path | Purpose |
|---|---|
| `POST /v1/bookings/{id}/payments` + **`Idempotency-Key`** | Start (or reuse the open) payment attempt for a `PENDING_PAYMENT` booking: creates a provider order for the booking total; returns `{id, status, provider, amountPaise, checkout}` (public checkout values only). 15/h per customer |
| `POST /v1/payments/{id}/return` `{providerPaymentId?, signature?}` | The browser is back from checkout: triggers a server-side provider query. Never marks success by itself |
| `GET /v1/payments/{id}` · `GET /v1/bookings/{id}/payments` | Attempts and refunds of the customer's booking |
| `POST /v1/webhooks/payments/{fake\|razorpay}` | Provider webhooks: raw JSON body, HMAC signature header, no session/CSRF; 401 if the signature is invalid; `{status: processed\|duplicate\|ignored\|quarantined}` |
| `POST /v1/dev/fake-checkout/{paymentId}` `{outcome}` | Development/test only with the fake provider |
| `GET /admin/v1/payments/reconciliation` · `POST …/{itemId}/resolve` `{note}` | FINANCE admins: open reconciliation items |

Error codes: `payment.booking_not_payable` (409), `payment.idempotency_key_required` (400), `payment.invalid_signature` (401), `payment.malformed_webhook` (400).

### Host earnings and payouts (Phase 16)

| Method and path | Purpose |
|---|---|
| `GET /v1/host/earnings` | Balances (pending, available, in payout, paid, receivable), release window, minimum payout, per booking: customer paid, refunded, gross, customer fee, commission, tax, net, status |
| `GET /v1/host/payouts` | Payout history (amount, status, bank reference, failure) |
| `GET /v1/host/payout-account` · `PUT /v1/host/payout-account` `{method: UPI, holderName, vpa}` or `{method: BANK, holderName, accountNumber, ifsc}` | Masked current account; owner-only change; 72 h hold after a change |
| `GET /admin/v1/payout-accounts/pending` · `POST …/{id}/review` `{decision}` | FINANCE: verify (sees full details) |
| `GET /admin/v1/payouts/open` · `POST /admin/v1/payouts/{id}/settle` `{status: PAID, reference}` or `{status: FAILED, reason}` | FINANCE: record transfers |
| `GET /admin/v1/ledger/trial-balance` | FINANCE: debits = credits per account code |

Error codes: `payout.owner_only` (403), `payout.invalid_details` (400), `payout.transition_not_allowed` (409).

### Access and recourse (Phase 17)

| Method and path | Purpose |
|---|---|
| `GET /v1/bookings/{id}/access` · `POST …/access/reissue` · `POST /v1/bookings/{id}/check-in` | C-12: status, 6-digit code, plate, space, window, `canCheckIn`, pass token; reissue; "I'm here" |
| `GET /v1/access/pass/{token}` | Driver pass (no account): code, plate, space, window, address, instructions |
| `GET /v1/gate/{token}` · `POST /v1/gate/{token}/lookup` `{plate}\|{code}\|{pass}` · `POST /v1/gate/{token}/entries` `{ticket}` | Guard link: verdict + space + until + expected plate (+ entry ticket); record entry |
| `GET/POST /v1/host/properties/{id}/gates` · `DELETE …/gates/{gateId}` · `GET …/access-log` | Owner: guard links (token shown once) and access log |
| `POST /admin/v1/properties/{id}/gates` · `GET …/access-log` | TRUST_SAFETY for societies |
| `POST /v1/bookings/{id}/issues` `{kind, note?}` · `POST /v1/bookings/{id}/issues/{issueId}/withdraw\|escalate` | Customer recourse |
| `POST /v1/host/bookings/{id}/issues/{issueId}/resolve\|escalate` · `POST /v1/host/bookings/{id}/no-show` | Host response; no-show report |

Booking views add `issue` (and `canReportNoShow` for hosts). Error codes: `access.not_available`, `access.outside_window` (409), `access.invalid_gate` (401), `access.invalid_ticket` (400), `access.invalid_pass` (404), `access.owner_only` (403), `issue.not_in_window`, `issue.already_open`, `issue.not_open` (409).

### Notifications (Phase 18)

| Method and path | Purpose |
|---|---|
| `GET /v1/me/notifications` · `POST /v1/me/notifications/read` `{ids}\|{all: true}` | In-app inbox (rendered title/body/link, category, read) and unread count |
| `GET/PUT /v1/me/notification-preferences` `{whatsapp, sms, email, push}` | Channel opt-outs (critical messages still use SMS) |
| `POST /v1/webhooks/messaging/{provider}` | Signed delivery receipts (no session/CSRF) |

### Reviews and disputes (Phase 19)

| Method and path | Purpose |
|---|---|
| `GET/POST /v1/bookings/{id}/review` `{rating, dimensions?, body?}` | Participant view (`canReview`, `mine`, `theirs` once published) and submit |
| `GET /v1/listings/{id}/reviews` | Public published reviews, average from 3, dimension averages |
| `GET /v1/host/bookings/{id}/customer-trust` | Host: customer trust signals |
| `GET/POST /v1/bookings/{id}/disputes` `{category, description, requestedOutcome}` · `GET /v1/disputes/{id}` · `POST …/messages` `{body}` · `POST …/evidence` (raw image) · `GET /v1/dispute-evidence/{id}` | Parties: open, timeline, photos |
| `GET /admin/v1/disputes` · `GET …/{id}` · `POST …/{id}/review\|request-info\|escalate\|close` `{note?}` · `POST …/{id}/resolve` `{outcome, refundPaise?, note}` · `GET /admin/v1/dispute-evidence/{id}` | SUPPORT / TRUST_SAFETY (HIGH risk: TRUST_SAFETY only) |
| `POST /admin/v1/reviews/{id}/remove` `{reason}` | TRUST_SAFETY moderation |

Error codes: `review.not_eligible`, `review.already_submitted` (409), `review.contact_details` (400), `dispute.not_allowed`, `dispute.already_open`, `dispute.closed`, `dispute.transition_not_allowed` (409), `dispute.trust_safety_only` (403), `dispute.contact_details` (400), `evidence.unsupported` (415), `evidence.limit_reached` (409).

### Admin console API (Phase 20, `/api/admin/v1`)

Lists (all `?offset&limit≤100`, returning `{items, offset, limit, total}`): `users?q&status` (q = exact phone or name), `hosts?q&status`, `properties?q&kind&participation`, `assets?q&status&type&hostAccountId`, `bookings?status&q(id prefix)&hostAccountId&customerId&from&to`, `payments?status&bookingId`, `refunds?status`, `payouts?status&hostAccountId`, `reviews?status&authorKind`, `audit?entityKind&entityId&actorId&action`. Details: `users/{id}`, `bookings/{id}` (with history). Actions (with `{reason}`): `users/{id}/suspend|reinstate`, `hosts/{id}/status` `{status, reason}`, `bookings/{id}/cancel`. Views: `config`, `fraud-indicators`. Existing Phase 9–19 admin endpoints are listed above.

### Analytics (Phase 21, `/api/admin/v1/analytics`)

Any admin permission. `overview?days` (1–365, default 30) → `{window, supply{hosts, byType[], utilisation}, demand{customers, searches, listingViews, bookings, conversion, repeatCustomers, repeatRate}, marketplace{gmvPaise, refundsPaise, netGmvPaise, platformRevenuePaise, commissionPaise, serviceFeePaise, taxPaise, averageBookingValuePaise, cancellation, noShowRate, retention}, daily[]}`; `liquidity?days&type` → `{window, areas[{cell, areaLabel, searches, zeroResultSearches, zeroResultRate, publishedListings, confirmedBookings}]}` (≤ 100, most zero-result first). Ratios are null when undefined. Definitions: `docs/analytics.md`.

### AI (Phase 22)

`POST /api/v1/ai/search-intent` `{text}` (3–300 chars; anonymous; 10/min and 200/day per IP) → `{id, filters{type, place, useMyLocation, mode, date, from, to, maxPricePaise, covered, security, evReady, vehicleClass, connector, currentType, minPowerKw}, chips, notes, answeredBy}`; `POST /api/v1/ai/search-intent/{id}/feedback` `{helpful}` → 204 once / 404; `GET /api/admin/v1/ai/usage?days` (any admin). The filters feed the regular search; nothing here can book, price or check availability (docs/ai-strategy.md).

### Production hardening (Phase 23)

- `GET /api/health/ops` — bearer `OPS_MONITOR_TOKEN` (404 when unset): `{status: ok|warn|critical, at, checks[{name, status, value}]}`, 503 when critical (production-readiness §5).
- `GET /api/admin/v1/ops/health` (any admin) — the same with area, thresholds and runbook text.
- `GET|POST /api/admin/v1/users/{id}/clearance` — pilot clearance (`{decision: CLEARED|REVOKED, reason}`, POST TRUST_SAFETY); booking returns `booking.customer_not_cleared` (403) when `PILOT_CUSTOMER_CLEARANCE` is on and the customer isn't cleared (D-168).
- `GET|POST /api/v1/me/data-requests` (`{kind: ACCESS|CORRECTION|ERASURE, details?}`; 201, or 200 with the open one); `GET /api/admin/v1/data-requests?status`, `POST /api/admin/v1/data-requests/{id}/resolve` `{status: COMPLETED|REJECTED, resolution}` (TRUST_SAFETY, D-169).
- Every route is guarded or on the reviewed public list in `test/integration/route-security.test.ts`.

There is **no endpoint that confirms a booking**: confirmation comes only from a verified payment event (D-093, D-121).

Booking error codes: `booking.listing_unavailable` (409), `booking.unavailable` (409, `title` "Just booked by someone else" or "Not available for that time", `detail` names the reason), `booking.quote_invalid` (400), `booking.quote_expired` (409: expired, used, or already booked), `booking.idempotency_key_required` (400), `booking.idempotency_conflict` (409), `booking.vehicle_incompatible` (400), `booking.own_listing` (409), `booking.transition_not_allowed` (409), `vehicle.not_found` (404), `vehicle.plate_invalid` (400), `vehicle.limit_reached` / `vehicle.plate_in_use` (409).

### System

| Method and path | Purpose |
|---|---|
| `GET /health/live` | The process is up |
| `GET /health/ready` | DB reachable and all migrations applied (200 or 503) |

---

## 4. Authentication model (as built)

```
Phone ──request──▶ challenge (5 min, 6-digit code stored as keyed HMAC, 5 attempts, newest supersedes older)
      ──verify───▶ existing ACTIVE user → session
                   new number          → registration ticket (15 min, single use, hashed)
                   suspended           → 403
      ──register─▶ user + CUSTOMER + TERMS/PRIVACY consents + session  (atomic; concurrent use → one account)
Admin ─verify───▶ TOTP ticket (5 min, 5 attempts) ──totp──▶ ADMIN session
```

| Session | Idle (sliding) | Absolute | Cookie |
|---|---|---|---|
| USER | 30 days | 90 days | `__Host-pb_session`, HttpOnly, Secure, SameSite=Lax, Path=/ |
| ADMIN | 60 minutes | 8 hours | `__Host-pb_admin` (same attributes) |

- Tokens are 256-bit random values. Only their SHA-256 hash is stored. The sliding expiry is written at most every 5 minutes.
- A session stops working immediately when the user is suspended, the session is revoked or expires, or (for admin sessions) PLATFORM_ADMIN is removed.
- Admin powers require an ADMIN session. A platform admin's user session carries no permissions.

| Rate limit | Window |
|---|---|
| OTP send per number | 1 per 30 s, 5 per hour (shared across customer and admin sign-in) |
| OTP send per IP | 20 per hour |
| OTP verify per IP | 60 per hour (plus 5 attempts per challenge) |
| TOTP per admin | 10 per hour (plus 5 attempts per ticket) |
