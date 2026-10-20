# Final QA

Phase 23. This covers the complete test run, coverage by PHASES.md category, the UX review and the issues found and fixed in this phase. Date: 2026-10-20.

## 1. Complete test run

| Suite | Command | Result |
| --- | --- | --- |
| Format, lint (incl. module boundaries), typecheck, unit + integration tests, build | `pnpm check` | **Pass, exit 0.** API: 42 files, **607 tests**. web-kit, config and contracts tests also pass |
| End-to-end: production builds, strict CSP, desktop and mobile viewports | `pnpm e2e` | **30/30 passed** (15 journeys × 2 viewports) |
| Dependency audit (production) | `pnpm audit --prod` | **0 vulnerabilities** |
| Dependency audit (all) | `pnpm audit` | 1 high (braces, dev-only lint plugin, no fix published). Handlebars criticals fixed by override |
| AI evaluation (rules parser; no model key) | `pnpm ai:eval` | 73/73 fields (100%) |
| Migrations on a fresh database | CI step plus every integration test file | Pass (17 migrations) |

## 2. Coverage by category (PHASES.md)

| Category | Where it is tested |
| --- | --- |
| Unit | 19 unit files: availability engine and coverage, booking state machine, series, charging session, earnings split, discovery presentation, crypto, session tokens, env validation, plates, notifications policy, AI parser, schema and evaluator, Razorpay signatures, migration files, module boundaries |
| Integration / API | 23 integration files against real PostgreSQL + PostGIS through the HTTP API: identity, listings, discovery, availability, booking, series, charging, payments, earnings, access, notifications, reviews and disputes, admin, analytics, AI, ops, pilot clearance, data requests, route security, rate limiter, readiness, migrator, job runner |
| Security | Route-security inventory; authorisation per role and permission in every module; ownership as 404; CSRF; cookie flags (e2e); CSP violations fail e2e; enumeration-safe OTP; PII never in lists or logs; exact location never public (L-9); signed tokens and webhooks; prompt-injection outputs rejected |
| Concurrency | Parallel same-unit bookings (exactly one wins); same-key retries replay; series vs. single-booking races; block vs. booking lock contract; parallel webhook duplicates (lease); rate-limiter atomicity. (Per-host payout and refund serialisation, D-134, is by advisory lock and not yet covered by a parallel test: see technical debt.) |
| Payment | Success, failure, duplicate webhook, delayed webhook, amount mismatch (quarantine + refund), refunds (customer, host, platform, dispute, recourse), reconciliation, settlement import, ledger balance and trial balance |
| Critical workflows (e2e) | Sign-up, account and data request · discovery without the exact address · natural-language search · hourly booking → pay → access code → guard check → "I'm here" → can't-get-in recourse · monthly request → host approval · host listing → admin approval → calendar · EV charger listing → booking → start and stop charging · completed booking → blind review → dispute · admin sign-in with TOTP → console (users, analytics) |

## 3. UX review

| Journey | Review | Status |
| --- | --- | --- |
| Onboarding | OTP sign-in in 2 screens; consent before account creation; name and language; device list | Good. No email or social sign-in (by design) |
| Discovery | Place autocomplete or device location; filters; natural-language box with "We understood" chips; empty state with "Search within 10 km"; approximate location only | Good. **No map yet** (AR-3, blocker B4) |
| Listing (host) | Guided new-listing flow; photos; availability editor; pricing; submit for review with clear status | Good. No map pin for placement (R-63) |
| Booking | Server quote with price breakdown before booking; cancellation policy shown; hold countdown; request-to-book for approval listings | Good |
| Payment | Razorpay Checkout; returning to the app never trusts the client; pending, failed and retry states | Good. Live checkout untested (B3) |
| Access | Code, pass and plate shown only in the window; guard page is one screen; "I can't get in" in the window with the 15-minute promise | Good |
| Host management | Today page, bookings, calendar, monthly plans, gates, earnings and payouts | Good |
| Earnings | Gross, fees, commission, net; pending, available and paid; payout account with hold | Good |
| Errors | problem+json with `userMessage` everywhere; request IDs for support; specific booking errors (just booked, not available, verify first) | Good |
| Recovery | Retry buttons on every async error; idempotent submits; expired holds release; recourse refund; dispute path | Good |

Accessibility checks:

- labels on all inputs;
- `role="alert"` on errors;
- `aria-live` on results and chips;
- keyboard-operable comboboxes;
- e2e uses role and label locators throughout, which catches unlabeled controls.

## 4. Issues found and fixed in Phase 23

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | High (privacy) | Admin property detail decrypted the exact address with no per-view log (R-56) | Every admin view is audited as `property.address_viewed`; tested |
| 2 | High (trust) | Any signed-in customer could book residential spaces while ID and RC verification don't exist (R-62) | Pilot clearance gate (`PILOT_CUSTOMER_CLEARANCE`): trust & safety clears or revokes with a reason, the decision is audited, and booking is refused otherwise (D-168) |
| 3 | High (legal) | No way to exercise DPDP rights (R-55) | In-app requests (access, correction, erasure) with a due date, an admin queue, audited resolution, an overdue alert and an erasure runbook (D-169) |
| 4 | High (operations) | No alerting: stuck jobs, refunds or gate issues would go unnoticed | Ops health checks, `/api/health/ops` for monitors (503 on critical) and an admin dashboard panel (D-170) |
| 5 | Medium (security) | No systematic proof that every route is protected | Guard markers and a route-security inventory test with a reviewed public allowlist (D-170) |
| 6 | Medium (supply chain) | 3 critical handlebars advisories in dev tooling | pnpm override to 4.7.10 |

No critical issue remains open in the code. The launch blockers are external dependencies (launch-checklist §1).
