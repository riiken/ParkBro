# Launch Checklist and Pilot Plan

Phase 23. This is the ordered list of what must be true before the pilot opens, who owns each item, and how the pilot runs. Statuses as of 2026-10-20.

Owners:

- **Owner**: the product or business owner.
- **Eng**: engineering.
- **Ops**: trust & safety and support.
- **Fin**: finance.

## 1. Blocking: must be done before the first real booking

| # | Item | Owner | Status | Notes |
| --- | --- | --- | --- | --- |
| B1 | Legal entity and brand name confirmed (D-009, AR-5) | Owner | Open | Needed for DLT, Razorpay and the app stores |
| B2 | TRAI DLT registration, SMS templates, and WhatsApp BSP approval | Owner | Open | R-46. Then Eng adds the OTP and messaging adapters (`OtpSender`, `MessagingProvider`), about 1–2 days each |
| B3 | Razorpay account with test and live keys; run the sandbox checklist (success, failure, refund, webhook replay, CSP checkout) | Owner + Eng | Open | R-68. The adapter is built and tested against the simulator |
| B4 | Maps vendor and key; geocoder adapter; map on the listing page | Owner + Eng | Open | AR-3. The fixture refuses to run in production |
| B5 | Cloud choice (AR-1) | Owner + Eng | Open | Needs: managed PostgreSQL 17 + PostGIS with daily backups and PITR; containers for api, web and admin; object storage for photos; KMS-wrapped field keys; TLS on separate web and admin subdomains |
| B6 | Production secrets generated and stored in a secret manager | Eng | Open | `FIELD_ENCRYPTION_KEYS`, `BLIND_INDEX_KEY`, `SESSION_*`, Razorpay, `OPS_MONITOR_TOKEN`; never the dev values (refused at start-up) |
| B7 | Counsel review: Terms, Privacy, DPDP notice and consent text, liability (D-027), data-request deadlines (§6.1 runbook) | Owner | Open | Bump the consent version on publish |
| B8 | CA review: GST on fees and commission, TCS/TDS for host payouts, invoice format | Owner + Fin | Open | R-70. Ledger tax account is ready |
| B9 | Git remote, first commit, CI green on the remote (unit, integration, e2e, audit) | Owner + Eng | In progress | Pushed to `github.com/riiken/ParkBro` (`main`); confirm the CI run is green |
| B10 | Database roles: app role without DDL; migrations run by a separate role; read-only role for analytics | Eng | Open | database-design §12 |
| B11 | Monitoring wired: uptime check on `/api/health/ready` and `/api/health/ops` (bearer token), log shipping, an alert on error-rate spikes, someone on call during pilot hours | Eng + Ops | Open | production-readiness §5 |
| B12 | `PILOT_CUSTOMER_CLEARANCE=true`, `AI_PROVIDER=none` (until R-84), `MESSAGING_PROVIDER` set to the real adapter, `API_DOCS_ENABLED=false` | Eng | Open | |
| B13 | Restore drill: restore last night's backup into staging, and run migrations and the e2e suite against it | Eng | Open | Proves backups work |
| B14 | Support runbooks rehearsed: stuck at the gate, payment incident, dispute handling, data requests | Ops | Open | production-readiness §6 |

## 2. Already done (verified in this phase)

| Item | Evidence |
| --- | --- |
| Full test suite green: 607 API tests (unit + integration) and 30 e2e on production builds with strict CSP | final-qa.md |
| Route security inventory: every route guarded or reviewed public | `route-security.test.ts` |
| Production refuses unsafe configuration: dev keys, fake payments, test Razorpay keys, console messaging, fixture geocoder, no OTP provider, database without TLS | env validation and tests |
| Admin address views audited (R-56) | admin test |
| Pilot clearance gate for controlled customers (R-62 mitigation) | pilot-clearance test |
| Data-rights request intake and admin queue (R-55) | data-requests test, e2e |
| Ops health checks and alert endpoint | ops test |
| Production dependencies have no known vulnerabilities | `pnpm audit --prod` |

## 3. Should do soon after launch (not blocking a controlled pilot)

These are needed before widening the pilot:

- KYC providers for ID and vehicle RC (R-62, R-72), replacing the manual clearance.
- Automated erasure and self-service data export (runbook meanwhile).
- Admin lost-authenticator recovery flow (R-53). Today it is CLI only.
- QR rendering of the driver pass (D-137), if guards ask for it.
- A live AI model: key, DPA, and `pnpm ai:eval` at 90% or more (R-84).
- Load test with production-size data. Daily analytics rollups when needed (R-82).

## 4. Pilot plan

```
ONE CITY → LIMITED NEIGHBOURHOODS → LIMITED HOSTS → LIMITED ASSETS → CONTROLLED CUSTOMERS
        → MEASURE → LEARN → IMPROVE → EXPAND
```

| Stage | Pilot setting |
| --- | --- |
| City | Bengaluru, which the product, timezone and locality data already assume (D-004) |
| Neighbourhoods | 2–3 adjacent, dense, mixed-use areas with parking pain and EV interest, for example Koramangala, HSR Layout and BTM Layout. Confirm with the owner (D-009) |
| Hosts | 20–40 hand-recruited: independent houses, small commercial properties and 1–2 participating societies. Every listing is human-reviewed (D-069) |
| Assets | 50–100 parking spaces and 5–15 home or commercial AC chargers. No DC-fast promises |
| Customers | Invite-only. Each is cleared by trust & safety after an RC and ID check on a call (`PILOT_CUSTOMER_CLEARANCE=true`). Target 200–400 cleared drivers |
| Duration | 8–12 weeks, reviewed weekly |
| Support | Pilot hours 07:00–23:00 IST, with an on-call phone for gate issues (15-minute recourse) |

### Measure

The admin Analytics page holds these metrics. Review them weekly.

- **Liquidity:**
  - zero-result search rate per area, aiming under 30%;
  - search → booking conversion;
  - booking success rate, aiming at least 70%;
  - utilisation per area.
- **Trust:**
  - cancellation rate by party;
  - no-show rate;
  - "can't get in" issues, and how many end in a refund;
  - disputes per 100 bookings, and high-risk ones.
- **Economics:**
  - GMV;
  - platform revenue;
  - average booking value;
  - host earnings paid on time.
- **Retention:** host and customer retention from period to period, and repeat customers.
- **Operations:** ops checks green, payment and notification failures, AI fallback rate (rules only during the pilot).

### Learn → improve → expand

Expand only when **all** of these hold for four consecutive weeks:

- zero-result rate under 30% in the pilot areas;
- booking success at least 70%;
- recourse refunds under 5% of bookings;
- no unresolved high-risk dispute older than 7 days;
- ops checks have had no critical alert lasting more than 1 hour.

Then:

1. Add 1–2 neighbourhoods at a time.
2. Recruit supply first, guided by the liquidity-by-area table.
3. Open customer sign-up only after KYC providers replace manual clearance.
