# Production Readiness

Phase 23 audit, 2026-10-20. Audited against CLAUDE.md, PHASES.md, the decision log (D-001 to D-171) and the risk register.

## 1. Verdict

**The core marketplace is ready for a controlled pilot. It is not ready for an open public launch.**

The following are built, tested and hardened:

- the booking, payment, ledger, access and dispute flows;
- trust and location privacy;
- the admin tooling.

Production start-up is **intentionally refused** until four external dependencies exist:

- a DLT-registered SMS/WhatsApp OTP and messaging provider;
- a maps geocoder;
- live Razorpay keys, after a sandbox run;
- production secrets.

The API's env validation enforces this, so a misconfigured deploy cannot go live by accident. Those dependencies, plus deployment infrastructure and legal review, are the launch blockers in `launch-checklist.md`.

## 2. Security review

| Area | State | Evidence | Remaining gaps |
| --- | --- | --- | --- |
| Authentication | Phone OTP (enumeration-safe, attempt limits, lockout); `__Host-` HttpOnly Secure SameSite=Lax cookies; sliding and absolute session expiry; revocation; admin on a separate origin with OTP + TOTP | identity tests; e2e cookie assertions | No production OTP provider (R-46); admin lost-authenticator recovery is CLI-only (R-53) |
| Authorisation | Guard preHandlers (user / role / admin permission) plus ownership checks in services (someone else's resource returns 404); per-permission admin endpoints; host access per host account | **New `route-security.test.ts`**: every route is either guarded or on a reviewed public allowlist with reasons; every admin route needs an admin permission; CSRF exemptions are webhooks only | — |
| Secrets | Env only; `.env` git-ignored; production refuses development keys and test Razorpay keys; startup config log is an allowlist (no keys); provider error bodies never logged | env tests | Keys come from env, not a KMS (AR-1); CI secret scanning needs a remote |
| PII | Field encryption (phone, plate, address, codes) with blind indexes for lookup; log redaction paths; route-pattern logging (no raw URLs); masked phones in admin; no text stored for analytics or AI | crypto, identity and logging tests | Automated erasure is a runbook for now (§6.1) |
| Location privacy | Public views expose only a fuzzed point (~110 m) and area label; the exact address appears only after booking, to the parties; admin address views are **now audited as PII reveals** (R-56 closed) | discovery L-9 tests; admin test (`property.address_viewed`) | — |
| Payment security | Success comes only from verified webhooks or a provider query; HMAC signatures checked; amount and order mismatches quarantined and refunded; idempotent webhooks (dedupe lease); no card data on our servers (Razorpay Checkout) | payments tests (success, failure, duplicate, delayed, mismatch, refund) | Live sandbox run pending (R-68) |
| Webhooks | Raw-body signature verification; CSRF exempt only for signed webhooks; the console messaging provider accepts none; the fake payment provider is refused in production | payments and notifications tests; route-security | — |
| Rate limiting | PostgreSQL counters with hashed keys on OTP send and verify (per IP and phone), search, places, booking creation, gate lookups, pass views, AI and feedback | rate-limiter tests and per-feature tests | Per-IP limits are coarse behind carrier NAT; tune with real traffic |
| Abuse | No self-booking; host-reported no-shows with safeguards; review integrity (completed paid bookings only, blind); fraud indicators; contact-detail filters in public text; **pilot clearance gate (new)** | booking, review and admin tests | Automated anomaly detection is later (R-79) |
| Injection | All SQL through Kysely or parameterised `sql` templates (audited: no `sql.raw` or string interpolation); Zod validation on every input; no HTML rendering of user content (React escaping); strict CSP with nonces; AI output schema-validated | grep audit; CSP e2e (no violations) | — |
| Data access | Module boundaries enforced by lint and a test; read-only query modules (discovery, analytics, ops) read without writing; AI has no marketplace access | module-boundaries test | A database role split (`readonly_analytics`, app role without DDL) is still to do; see the launch checklist |
| Dependencies | `pnpm audit --prod`: **0 vulnerabilities**. Dev tooling: a handlebars override fixed 3 advisories; 1 remaining (braces, inside the Next lint plugin; no patched version; dev-only, no untrusted input) | CI runs `pnpm audit --prod --audit-level high` | Re-check braces when a fix ships |

## 3. Reliability review

| Scenario | Behaviour | Evidence |
| --- | --- | --- |
| Booking concurrency | Exclusion constraint on unit and blocked period; lock order series → property → asset → bookings; availability re-checked in the transaction; idempotency keys with replay; real parallel tests | booking and series concurrency tests |
| Payment failure | FAILED state; customer told; hold expires; retry allowed; no money taken | payments tests; e2e failed-payment message |
| Webhook retries | Dedupe with a 10-minute lease (duplicates tested, including parallel ones); transitions only move forward from allowed states; reconciliation job queries the provider for stuck payments | payments tests |
| Notification failure | Outbox rows; retries at 1, 5, 30, 120 and 360 min; permanent errors fail fast; SUPPRESSED when there's no address; delivery receipts | notifications tests |
| Database failure | Readiness returns 503 (load balancer stops routing); requests fail with problem+json 500 and a request ID; pool errors logged; transactions keep state consistent; jobs retry on the next tick | readiness tests |
| External services | Payments: reconcile and refund jobs retry. Messaging: retries. Geocoder: errors are user-visible, search still works by device location. AI: rules fallback on timeout, error or invalid output | per-module tests |
| AI failure | Never blocks search; budget cap; fallback reason recorded | ai tests |
| Job failure | pg-boss singleton schedules; every job idempotent; **ops checks detect the symptoms** of a stopped job (unexpired holds, unfinished bookings, issues past deadline, backlogs) | ops tests |
| Process restarts | Graceful SIGTERM: stop jobs, close the server (503 while closing), end the pool; work survives in the database | main.ts |

Not yet covered:

- **Backups and point-in-time recovery.** These depend on the managed PostgreSQL choice (AR-1); see the launch checklist.
- **Multi-instance load test.**

## 4. Performance review

- **Queries and indexes.**
  - Indexes follow query patterns (database-design §9).
  - Discovery uses PostGIS GiST and was checked with EXPLAIN in Phase 10.
  - Bookings use the exclusion GiST index.
  - The admin and analytics aggregates use time indexes.
- **Measured latency.** Local, dev data, measured during this audit:

  | Endpoint | p50 | p95 |
  | --- | --- | --- |
  | search | 5 ms | 9 ms |
  | listing view | 5 ms | 38 ms |
  | place autocomplete | 1 ms | 3 ms |
  | readiness | 2 ms | 5 ms |

  Pilot targets are p95 under 300 ms for search and under 500 ms for booking. Re-measure with production-size data (thousands of listings) before expanding.
- **Search.** Candidates are capped at 500 before the in-app availability check (D-077). That suits a pilot city; R-60 and D-077 cover the scale path.
- **Maps.** No map tiles yet (AR-3). The fixture geocoder runs in memory.
- **Booking.** About 10 queries in one transaction. The bottleneck is lock contention per property, which is by design.
- **Caching opportunities, not needed yet.**
  - Public listing photos already send `cache-control: public, max-age=3600`.
  - Discovery responses must stay uncached, because availability changes.
  - Places autocomplete could be CDN-cached.
  - Analytics could use daily rollups (R-82).
- **Known debt.**
  - Booking-list N+1 reads (R-60).
  - Offset pagination in admin (R-81).

## 5. Observability

| Need | State |
| --- | --- |
| Logs | Structured JSON (pino) with `requestId` on every line and response; route pattern, status and response time per request; redaction safety net; 5xx logged at error level with the error |
| Metrics | Request latency and status come from logs (`responseTime`); marketplace metrics from admin Analytics; AI cost, latency and errors from `ai.invocations`. A Prometheus-style endpoint is deliberately not built: the pilot uses log-based metrics in the hosting provider |
| Error tracking | Error-level logs with request IDs. Ship logs to the provider's log service and alert on error rate. A Sentry-type service is optional before scale |
| Health checks | `/api/health/live` (process) and `/api/health/ready` (database + migrations, 2 s timeout) |
| Alerts | **New `/api/health/ops`**: bearer `OPS_MONITOR_TOKEN`, returns 503 when any check is critical, so any uptime monitor can page on it. The same report appears on the admin dashboard with thresholds and runbook text |
| Payment monitoring | Ops checks for payments awaiting confirmation, mismatches, stuck and failed refunds; the reconciliation queue in admin Payments; the trial balance |
| Booking monitoring | Ops checks for unexpired holds and approvals, unfinished bookings, and issues past deadline or escalated; analytics for booking success, cancellation and no-show |
| AI monitoring | Ops check for model failures per hour; admin Analytics AI table (model, cost, latency p50/p95, errors, fallbacks, tool calls, feedback); daily budget |

### 5.1 Ops checks (alert thresholds)

| Check | Warn at | Critical at | Likely cause → action |
| --- | --- | --- | --- |
| holds_not_expired | 1 | 10 | expire-holds job down → check the job runner and logs |
| approvals_not_expired | 1 | 10 | booking-transitions job down |
| bookings_not_completed | 1 | 20 | booking-transitions job failing → earnings stall |
| issues_past_deadline | 1 | 1 | booking-issues job down → **a customer may be stuck at a gate**: phone the host and cancel with a refund from admin |
| issues_escalated_24h | 1 | — | support must handle each escalation |
| payments_awaiting_confirmation | 1 | 10 | webhooks not arriving → check Razorpay status and webhook delivery; reconcile runs every 5 min |
| payment_mismatches_7d | 1 | 3 | investigate each (refunded automatically) |
| refunds_stuck | 1 | 5 | refund job or provider failing |
| refunds_failed_7d | 1 | 1 | finance resolves manually |
| payouts_processing_3d | 1 | — | finance to mark paid (UTR) or failed |
| notifications_backlog | 5 | 50 | delivery job or provider failing |
| notifications_failed_24h | 5 | 50 | provider or template problem |
| high_risk_disputes_waiting | 1 | — | trust & safety review |
| data_requests_overdue | 1 | — | legal deadline: fulfil now (§6.1) |
| ai_model_failures_1h | 10 | — | provider issue; search still works; consider `AI_PROVIDER=none` |
| jobs_failed_24h | 1 | 20 | failed job runs; see error logs |

## 6. Runbooks

### 6.1 Data-rights requests (DPDP)

Requests arrive in **admin → Data requests**, oldest due first, with a 30-day working default to confirm with counsel.

- **ACCESS.** Export the person's profile, vehicles (masked plates are not enough: decrypt via an admin script), bookings, payments, reviews and dispute messages. Send the export to their verified phone or email channel. Then mark it done.
- **CORRECTION.** Most fields are self-service (name, language, vehicles). For anything else, correct it and record what changed.
- **ERASURE.** Check there are no open bookings, disputes or payouts first. Then anonymise in place, as one audited transaction:
  1. Set the display name to "Deleted user".
  2. Replace the phone ciphertext and blind index with tombstones.
  3. Archive the vehicles and null their plates.
  4. Revoke the sessions.
  5. Set the status to CLOSED.

  Keep bookings, payments and the ledger, without personal fields, for the tax retention period. Then mark it done, with "anonymised per runbook".

Automating erasure is technical debt, to do before scale.

### 6.2 Customer stuck at a gate

Triggered by `issues_past_deadline`, or by an escalation:

1. Phone the host.
2. If the problem isn't fixed within minutes, cancel the booking from admin. This is a platform cancellation with a full refund.
3. Help the customer find a nearby alternative.

### 6.3 Payment incident

Triggered by `payments_awaiting_confirmation` or a reconciliation queue item:

1. Check the provider's status page.
2. The reconcile job queries the provider every 5 minutes.
3. Never mark a payment paid by hand. Confirmation comes only from the provider (D-093).
4. A mismatch is refunded automatically. Investigate the cause.

### 6.4 Job failure

Triggered by `jobs_failed_24h` or a symptom check:

1. Read the error logs for the job name.
2. Jobs are idempotent: fix the cause and the next tick catches up.
3. If the job runner is down on every instance, restart with `JOBS_ENABLED=true` on at least one instance.

## 7. Production-ready functionality

These are complete and tested:

- **Identity:** OTP sign-in, sessions, roles, admin TOTP.
- **Hosting:** properties and listings (parking and EV), photos and review.
- **Discovery:** privacy-safe discovery with filters, and natural-language search.
- **Availability and booking:** the availability engine; booking hourly, daily, overnight, monthly and charging sessions; approvals; cancellations with policies.
- **Money:**
  - payments (Razorpay adapter and simulator) with refunds and reconciliation;
  - the double-entry ledger, earnings and manual payouts.
- **Access:** codes, plate, driver pass, guard links, ANPR ingestion, and the 15-minute recourse refund.
- **Notifications:** the outbox and in-app inbox.
- **Trust:** two-sided blind reviews, trust signals, and disputes with evidence and human resolution.
- **Admin:** the admin console (users, hosts, properties, listings, bookings, money, reviews, disputes, fraud, configuration, audit, data requests, analytics, operations).
- **Compliance and controls:** data-rights requests, pilot clearance, ops alerting.

## 8. Not production-ready

| Item | Why | Blocks |
| --- | --- | --- |
| OTP and messaging provider | DLT and WhatsApp registration needs a legal entity (R-46, R-77) | **Launch** (production refuses to start) |
| Maps geocoder and map UI | Vendor not chosen (AR-3); fixture covers 15 Bengaluru localities | **Launch** (refused) |
| Live payments | Razorpay keys and sandbox checklist (R-68) | **Launch** (refused with test keys) |
| Deployment | No container images or infrastructure yet; cloud not chosen (AR-1); KMS, backups and PITR depend on it | **Launch** |
| Legal | Terms and Privacy are drafts; DPDP, GST/TCS and liability need counsel and a CA | **Launch** |
| Live AI model | Key, provider DPA and a passing eval (R-84) | Nothing: rules parser runs |
| KYC (ID, vehicle RC) providers | Not chosen (R-62, R-72) | Mitigated by pilot clearance; needed before open sign-up |
| Automated erasure, self-service data export | Runbook for the pilot | Scale |
| Web push, email, QR rendering, smart chargers and locks | No partner or need yet | Nothing |
