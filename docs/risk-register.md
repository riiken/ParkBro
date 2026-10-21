# Risk Register

Phase 0 baseline, updated in Phases 1–20 (2026-10-20) with research evidence from [competitive-analysis.md](competitive-analysis.md). Review and update at the end of every phase.

**Scale:** Likelihood (L) and Impact (I) are rated High / Medium / Low. **Phase** is where the main mitigation is designed or built. **Status:** Open (identified, not yet mitigated), Mitigating, Accepted, Closed.

---

## Marketplace and business

| ID | Risk | L | I | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| R-01 | **Cold start / low liquidity:** too little supply density, so searches return nothing and customers churn | H | H | Single city, few neighbourhoods; seed supply before demand; target dense demand clusters; track zero-result searches | 1, 21, 23 | Open (Phase 21: zero-result rate, utilisation and liquidity by ≈1 km cell in the admin Analytics page, analytics.md §7 playbook) |
| R-02 | Apartment supply blocked by society rules or permission. *Phase 1 evidence: Maharashtra model bye-laws 78–84 give the managing committee control of parking; several advocates view renting allotted slots to outsiders as impermissible.* | H | H | Society partnership model (S1); apartment hosts only with society consent; host attestation of right to rent; prioritise commercial and independent-house supply early (differentiation-strategy.md §3) | 1, 4 | Mitigating (strategy defined) |
| R-03 | Host earnings too small to justify effort, causing supply churn | M | H | Emphasise monthly bookings; near-zero-touch hosting; earnings transparency | 1, 13, 16 | Open |
| R-04 | Off-platform leakage after the first booking | M | M | Contact masking; value from guarantees, payments and protection that only exist on-platform; monthly products | 4, 13 | Mitigating (designed, §5, §12) |
| R-05 | Support cost per booking exceeds margin (especially hourly) | M | H | Self-serve access-failure flows, clear instructions, automation of low-risk resolutions | 3, 17, 19 | Open |
| R-06 | Competitors or incumbents already own the pilot area | M | M | Phase 1 found no dominant Indian private peer-to-peer parking player; differentiate on reliability and trust | 1 | Mitigating |
| R-36 | **Incumbent entry:** Park+ (3,000+ society gate installs, FASTag base) or MyGate / NoBrokerHood (tens of thousands of societies) launch private-parking marketplaces | M | H | Win micro-markets fast; society partnerships; reliability promise; serve cross-society and commercial demand; keep partnership option open | 1, 23 | Open |
| R-37 | Dependence on society visitor apps for guard verification: their APIs or partnerships may be unavailable | M | M | Access adapter abstraction; SMS / WhatsApp / web lookup fallback that needs no third party | 17 | Open |

## Trust, safety and access

| ID | Risk | L | I | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| R-07 | **Access failure on arrival** (guard refuses, gate closed, slot occupied). The highest-impact trust failure. | H | H | Guard-friendly verification without an app; pre-arrival guard notification; in-app "can't get in" escalation with auto-refund or rebook | 3, 17 | Open |
| R-08 | Fake or inaccurate listings, or a host without the right to rent | M | H | Risk-based listing verification; photo requirements; reports; reviews tied to completed bookings | 4, 9, 19 | Mitigating (Phase 9: attestation of right to rent, in-app photo pipeline with duplicate detection and V-GEO distance, human review of every listing; site visits operational) |
| R-09 | Customer misconduct on premises (theft, nuisance, unsafe entry into a residential complex) | L | H | Phone verification minimum; risk-based ID verification; vehicle registration; host and society controls; ban mechanism | 4, 8 | Mitigating (designed, §4, §7) |
| R-10 | Vehicle damage or theft; property damage. Liability unclear. | M | H | Terms allocating liability; evidence capture (photos at arrival); dispute process; evaluate insurance or guarantee | 4, 19 | Mitigating (designed, §7–8; insurance open) |
| R-11 | Customer personal safety (isolated or dark locations, late night) | L | H | Listing attributes (lighting, guard present); reviews on safety; support escalation | 4, 9 | Mitigating (designed, §7) |
| R-12 | Overstay blocks the next booking or the host's own car | M | M | Buffers between bookings; overstay policy and charges; escalation; reminders | 11, 12 | Mitigating (buffers enforced on both sides of reservations in the engine; overstay handling Phase 12/17) |
| R-13 | Ratings manipulation | M | M | Reviews only from completed bookings; anomaly detection later; ratings aren't the only safety mechanism | 19 | Mitigating (designed, §5) |

## Privacy and security

| ID | Risk | L | I | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| R-14 | **Exposure of exact residential locations** before booking, or to unauthorised users | M | H | Approximate public location; exact location only after a confirmed booking; API-level enforcement and tests | 4, 6, 10 | Mitigating (Phase 10: discovery reads only privacy-safe views; public coordinates rounded to ~110 m; L-9 tests at API and rendered-page level) |
| R-15 | PII leak (phone, vehicle number, ID documents) through APIs, logs or admin tools | M | H | Data minimisation; field-level access control; no PII in logs; audit logs on admin access; DPDP compliance | 4, 5, 8, 20 | Mitigating (phone encrypted at rest, keyed-hash lookups, no PII in logs or rate-limit keys, tested; more in later phases) |
| R-16 | Access credential reuse or sharing (OTP or QR used outside the window or by another vehicle) | M | M | Single-booking, time-boxed credentials; vehicle number binding; access logs | 17 | Mitigating (designed, §10) |
| R-17 | Account takeover (host account used to redirect payouts) | L | H | Re-verification on payout-detail changes; notifications on sensitive changes; payout hold after change | 8, 16 | Mitigating (admin TOTP + payout-change hold designed; payout part in Phase 16) |
| R-18 | Secrets committed or leaked | L | H | `.gitignore`, env validation, secret scanning, no secrets in logs | 7 | Mitigating (.gitignore, env validation without echoing values, log redaction tests, secret scan before commit; CI secret scanning still to add) |
| R-19 | Scraping or enumeration of listings, users or locations | M | M | Rate limiting; non-sequential IDs; approximate locations | 7, 10 | Mitigating (fuzzed points, non-sequential ids, per-IP search/listing/place rate limits; broader anti-scraping later) |

## Booking, payments and finance

| ID | Risk | L | I | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| R-20 | **Double booking / race conditions** | M | H | Transactional re-check; DB-level exclusion constraint on asset and time range; idempotency keys; concurrency tests | 6, 11, 12 | Mitigating (designed and validated against PostgreSQL, C1–C7, C15) |
| R-21 | Payment state wrong (client-trusted success, missed or duplicate webhooks) | M | H | Webhook-only confirmation with signature verification; idempotent handlers; reconciliation job | 15 | Mitigating (webhook dedupe validated, C11; full flow in Phase 15) |
| R-22 | Ledger errors (commission, tax or payout miscalculation; refund after payout) | M | H | Separate ledger entities; deterministic calculation; host negative balance; reconciliation; tests | 16 | Mitigating (ledger design validated, C9–C10) |
| R-23 | Timezone and DST bugs in availability and booking | M | M | Store UTC; asset-local timezone; boundary tests (IST has no DST, but design for it) | 11 | Mitigating (rule expansion per local date with Luxon; DST and midnight-crossing tested in coverage, engine and calendar) |
| R-24 | Recurring / monthly payment failures (mandate limits, failed renewals) | M | M | Grace periods; reminders; clear release rules | 13, 15 | Open |
| R-25 | Chargebacks and fraud via stolen payment instruments | L | M | Provider fraud tools; booking-linked evidence; velocity limits | 15, 19 | Open |

## Legal, regulatory and EV

| ID | Risk | L | I | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| R-26 | **Residential EV charging resale conflicts with DISCOM tariff or metering rules.** *Phase 1 evidence: MoP 2024 guidelines allow private chargers in a resident's own slot (existing meter or sub-meter) and separate metered connections with an EV tariff for RWA / community charging. Resale from a domestic meter to outsiders is not clearly addressed. Societies are also actively blocking chargers; legal position still settling (Bombay HC 2025; SC petition 2026).* | M | H | Legal review; pilot EV supply from independent-house, commercial and small-business hosts (H6) first; per-session or hour pricing framed as a parking + charging service; host attestation | 1, 14 | Open |
| R-27 | Payment aggregator / funds-flow regulatory non-compliance | L | H | Use a licensed aggregator with split or route settlement; legal review | 15 | Open |
| R-28 | GST / TCS / TDS obligations mis-handled | M | H | CA review before Phase 15; model taxes as separate ledger items | 15, 16 | Open |
| R-29 | DPDP Act non-compliance (consent, retention, breach notification) | M | H | Privacy-by-design; consent records; retention policy; legal review | 4, 6, 23 | Mitigating (designed, §14; counsel review open) |
| R-30 | Charger safety incident (fire, electrical fault) | L | H | Host attestations; listing safety requirements; incident reporting; insurance evaluation | 4, 14 | Mitigating (Phase 9: versioned charger-safety attestation required to publish EV listings; connection type captured) |
| R-38 | Ad-hoc EV charger sharing has thin demand and negligible host earnings (UK host study 2025) | H | M | Favour recurring neighbourhood matching; bundle with parking; don't make ad-hoc home charger sharing a pilot pillar | 1, 14 | Mitigating (strategy) |
| R-31 | Charger unavailable or faulty with no hardware telemetry | H | M | Self-reported status; fast refund path; host reliability scoring; future smart-charger interface | 14, 19 | Open |

## Delivery and engineering

| ID | Risk | L | I | Mitigation | Phase | Status |
|---|---|---|---|---|---|---|
| R-32 | **No dedicated git repository.** `ParkBro/` sits untracked inside an unrelated repo (`whatsapp-booking-assistant`), so work could be committed to the wrong project or lost. | H | M | Create a dedicated repo for `ParkBro/` before Phase 7 (owner decision, D-007) | 0 → 7 | Closed (dedicated repo created 2026-10-19; remote still to be added) |
| R-33 | Over-building: 24 phases of scope before any real-user validation | M | H | Keep pilot scope tight; validate H1–H6 early; phase discipline | All | Open |
| R-34 | Generic asset model is too abstract (slow to build) or too parking-specific (EV bolted on) | M | M | Phase 2 model checked against PARKING, EV_CHARGING and a hypothetical CAR_WASH_BAY (domain-model.md §8); type-specific data isolated in detail records | 2 | Mitigating |
| R-39 | Property-level outsider cap (BR-06) is a cross-asset invariant, so per-unit constraints alone can't enforce it under concurrency | M | M | Property-level serialisation inside the booking transaction; concurrency tests (domain-model.md V5) | 6, 12 | Mitigated (Phase 12: property lock + `maxConcurrent` in the booking transaction; concurrent cap test) |
| R-40 | Stale payment holds block inventory, or expired holds are double-used, at the DB-constraint level | M | M | BR-10: lapsed holds never block; expire in-transaction; constraint design in Phase 6 | 6, 12 | Mitigated (Phase 12: lapsed holds ignored by every read, expired in the booking transaction and by the 1-minute job; tested) |
| R-41 | PWA limitations (iOS push only when installed; no geofencing) weaken reminders and arrival detection | M | M | WhatsApp/SMS for critical messages (D-021); manual check-in plus guard verification; revisit native after pilot | 3, 18 | Mitigating |
| R-42 | Guard lookup link leaks or is abused to probe which vehicles are parked where | M | M | Per-property revocable tokens; rate limiting; minimal response (valid/not-valid only); lookups logged | 17 | Mitigating (designed, §10.3) |
| R-43 | Offline-cached access credentials on a lost or shared phone | L | M | Cache only current and next booking; time-bound credentials; clear on logout (UX-3) | 4, 17 | Mitigating (designed, §10.2) |
| R-44 | Customers or hosts assume the platform insures damage; reputational and legal exposure on the first damage incident | M | H | No implied insurance in UI or marketing; clear Terms; evaluate insurer partnership post-pilot (D-027) | 4, 23 | Open |
| R-45 | KYC friction at HIGH-risk bookings (residential overnight or monthly) depresses conversion | M | M | Verify once, reuse; explain why; measure drop-off; tune risk rules | 4, 12, 21 | Open |
| R-46 | India SMS needs TRAI DLT registration (entity, sender ID, every template); WhatsApp templates need approval. Lead time could block OTP and notifications at launch. | M | H | Start registration as soon as the brand and legal entity exist; WhatsApp OTP as a parallel channel; template inventory from ux §12 | 5, 18 | Open (development is unblocked by OTP_PROVIDER=console/dev-fixed; production start is refused until a DLT provider exists, D-057) |
| R-47 | Module boundaries erode in the monolith (cross-module writes, deep imports) | M | M | Lint-enforced boundaries, schema per module, owner-only writes, code review (D-032) | 7+ | Mitigating (designed) |
| R-48 | A single provider outage (payments, messaging) halts core flows | M | H | Adapter abstraction; reconciliation for payments; channel fallback for messaging; status page and runbook | 15, 18, 23 | Open |
| R-49 | Local dev on Apple Silicon uses an emulated amd64 PostGIS image (slower, potential divergence) | L | L | CI runs natively on amd64; option to switch to a multi-arch image in Phase 7 | 7 | Accepted |
| R-50 | Module-boundary lint silently misconfigured (plugin v7 resolves patterns from the process working directory; files became "unknown" and violations passed for the wrong reason) | M | M | Pinned `boundaries/root-path`, `partialMatch: false`; tests assert the specific `boundaries/dependencies` rule for every allow and deny case | 7 | Mitigating (found and fixed in Phase 7) |
| R-51 | Web CSP allows `'unsafe-inline'` scripts (Next.js inline runtime), weakening XSS protection | M | M | No user-generated HTML yet; move to nonce-based CSP before the first authenticated UI ships (Phase 8) | 8 | Closed (nonce-based CSP shipped Phase 8, D-060; verified by e2e) |
| R-52 | Native TypeScript execution forbids non-erasable syntax; a contributor adds an `enum` and it fails at runtime | L | L | `erasableSyntaxOnly` makes it a typecheck error; lint rule too; CI runs both | 7 | Mitigating |
| R-53 | Admin bootstrap requires shell and DB access (CLI); a leaked enrolment URI equals a stolen second factor | L | H | URI printed once; operators enrol immediately; grants audited; admin console with re-enrolment in Phase 20 | 8, 20 | Open |
| R-54 | Opportunistic cleanup (D-059) may lag under low traffic; tables grow slowly | L | L | Replace with scheduled jobs in Phase 12 | 12 | Closed (Phase 12: pg-boss jobs replace it, D-097) |
| R-55 | Account closure and DPDP data-rights requests are not implemented yet (users can't self-delete) | M | M | Design exists (trust-and-safety §14, users.data_requests); implement before pilot launch | 20, 23 | Mitigated (Phase 23: in-app requests, admin queue, overdue alert, erasure runbook; automation before scale) |
| R-56 | Admin views include exact property addresses without PII-reveal logging (`platform.pii_reveals` not built yet) | M | M | Only TRUST_SAFETY admins; all admin actions audited; add reveal-on-click + logging with the admin console (Phase 20) | 20 | Closed (Phase 23: every admin exact-address view audited as property.address_viewed) |
| R-57 | Local-disk photo storage is not durable or backed up | M | M | Dev/pilot only; move to an S3-compatible private bucket before staging (AR-1) | 23 | Open |
| R-58 | Search results include listings that are actually booked or blocked (coarse availability until Phase 11) | H | M | "Availability checked" flag in responses; Phase 11 adds exceptions and bookings; booking re-checks before commit (BR-07) | 11, 12 | Closed (Phase 12: search, window checks and the calendar see real holding bookings; booking re-checks at commit) |
| R-59 | Fixture geocoder covers only Bengaluru localities | M | L | Pilot is Bengaluru; real maps provider before launch (AR-3); "use my location" works anywhere | 10, 23 | Accepted |
| R-60 | Booking lists are N+1 (each row loads listing, vehicle and reveal data separately; up to 100/200 rows) | M | L | Pilot volumes; batch the lookups or add a read model and pagination when list p95 exceeds the SLO | 13, 21 | Accepted |
| R-61 | Holds without payment can squat inventory (10 minutes each) | M | M | 10-minute holds, 20 bookings/h and 120 quotes/h per customer, lapsed holds never block; add per-customer concurrent-hold cap if abuse appears | 12, 15 | Mitigating |
| R-62 | Risk-based customer verification (RC, ID) isn't enforced at booking (D-102) | M | H | No booking can be confirmed before Phase 15; enforce the trust-and-safety §4.1 tiers before payments go live | 13–15 | Mitigated (Phase 23: pilot clearance gate, D-168; KYC providers before open sign-up) |
| R-63 | Host-placed property points are only as good as the device location or locality centre (no map picker); a wrong point misleads fuzzing and V-GEO | M | M | Device location recommended in the flow; admin review sees capture distance; map picker with the maps vendor (AR-3) | 13, 23 | Open |
| R-64 | A monthly renewal held for a month blocks the space even if the customer never pays (up to period start + 3-day grace) | M | L | Intended (D-014); grace lapse ends the plan and frees the space; payments (Phase 15) make the renewal payable at creation | 13, 15 | Accepted |
| R-65 | Series job runs every 5 minutes; reads derive the request-ended state immediately but PAST_DUE/ENDED transitions can lag up to a tick | L | L | Reads compute effective status where it matters; job is idempotent | 13 | Accepted |
| R-66 | A future smart-charger adapter is called inside the session transaction; a slow vendor API would hold a DB connection and row lock | M | M | MANUAL is instant; adapters must time-box calls (≤ 5 s) or move to an async command + webhook model before the first real integration | 14, later | Open |
| R-67 | Self-reported sessions can't prove charging happened or how much energy was used | H | M | Pricing is time-based, not energy-based (D-117); faults are recorded with timestamps for recourse; metering only with a charger integration | 14, 19 | Accepted |
| R-68 | Razorpay checkout has not been exercised against the live sandbox or under the strict CSP (its injected styles may be blocked) | M | H | Adapter follows the documented API and is unit-tested against request/response shapes; run the sandbox checklist (order → checkout → webhook → refund → settlement) and adjust CSP before any real payment | 15, 23 | Open |
| R-69 | Payment holds are 10 minutes; slow UPI approvals can complete after the hold lapses | M | M | Late success revives the booking if the space is free, otherwise refunds in full automatically (tested); consider extending the hold while a checkout is open | 15 | Mitigating |
| R-70 | GST/TCS/TDS treatment of fees and refunds is not modelled yet | H | H | Ledger accounts in Phase 16 support any tax lines; CA review before launch (blocker 4) | 16, 23 | Open |
| R-71 | Manual payouts depend on finance doing transfers correctly and on time | M | M | One open payout per host, amounts from the ledger, UTR required to mark paid, failures return funds; automate with RazorpayX payouts when volume justifies | 16, later | Accepted |
| R-72 | V-ID for individual hosts is required before the first payout (trust-and-safety §4.2) but KYC is not built | M | H | Finance verifies payout account ownership manually; add ID verification before scale (TS-5) | 16, 20 | Open |
| R-73 | Society revenue share (BR-20) isn't modelled | L | M | No society has a share policy yet; add a SOCIETY_PAYABLE account and split line when the first society asks | Later | Accepted |
| R-74 | Guards may not use the link and wave cars in (or refuse valid ones) | M | H | One-screen guard page, expected plate shown, recourse refund within 15 min if access fails, access log for owners; society system adapters later | 17, 23 | Mitigating |
| R-75 | A shared driver pass can be forwarded further | L | M | Plate-bound (guard compares the plate), time-limited, revoked with the booking, rate-limited, each view logged | 17 | Accepted |
| R-76 | Host-reported no-shows could be abused to free a space | L | M | Allowed only ≥ 30 min after start with no check-in and no open issue; audited; customer can dispute (Phase 19) | 17, 19 | Mitigating |
| R-77 | No real messaging vendor: hosts don't get SMS/WhatsApp in production, weakening the 15-minute recourse window | H | H | In-app inbox and Today page work; register DLT templates and a WhatsApp BSP before launch (owner, R-46); provider adapter is a small module behind `MessagingProvider` | 18, 23 | Open |
| R-78 | Web push and email aren't implemented (no subscriptions, no verified emails) | M | L | Channels exist in the policy and schema; add VAPID push and V-EMAIL when needed | Later | Accepted |
| R-79 | Review manipulation (fake bookings to self-review, retaliation) | M | M | Reviews only from completed paid bookings, hosts can't book their own listings, blind publishing, averages from ≥ 3, moderation; anomaly checks later (Phase 21) | 19, 21 | Mitigating |
| R-80 | Dispute volume could overwhelm support before the admin console exists | M | M | API queue sorted HIGH first; admin UI in Phase 20; issues (15-min recourse) absorb on-site problems | 19, 20 | Mitigated (Phase 20 admin console) |
| R-81 | Admin offset pagination and ILIKE search won't scale to large tables | L | L | Pilot volumes; add keyset pagination and trigram indexes when an admin list p95 > 1 s | 20, later | Accepted |
| R-82 | Analytics queries scan raw events and bookings; long windows get slow as volume grows | L | M | Indexed aggregates suffice at pilot scale; add daily rollup tables (job-refreshed) when a 365-day overview p95 > 1 s (D-162) | 21, later | Accepted |
| R-83 | Utilisation is approximate (weekly rules, exceptions ignored; listings published mid-window counted for the whole window), and search cells vs fuzzed supply cells don't align exactly | M | L | Documented definitions (analytics.md §3); use for trends and area comparison, never billing; refine with exception-aware capacity if decisions hinge on it | 21 | Accepted |
| R-86 | Pilot launch depends on external registrations and vendors (DLT/WhatsApp, Razorpay live, maps, cloud, counsel/CA) with uncertain lead times | H | H | Production start-up refuses until each exists; launch-checklist §1 with owners; adapters are small (1–2 days each) | 23 | Open (owner action) |
| R-87 | Operational alerts need a monitor and someone on call; without them stuck gates or refunds go unnoticed | M | H | `/api/health/ops` + admin dashboard; launch-checklist B11, B14 (on-call in pilot hours) | 23 | Open |
| R-88 | Dev-tooling advisory (braces via the Next lint plugin) without a published fix | L | L | Dev-only, no untrusted input, not shipped; production audit clean; recheck periodically | 23 | Accepted |
| R-89 | Behind the web app's server-side proxy, the API may see the proxy's IP instead of the customer's, weakening per-IP rate limits | M | M | Staging is invite-only; before launch, forward the client IP from the edge and configure trusted proxy hops; per-phone limits still apply | 23, launch | Open |
| R-90 | Photon's public instance and OpenFreeMap are free community services with fair-use limits and no SLA | M | M | 10-minute search cache and built-in localities fallback; map failure hides the map but never blocks search or booking; self-host Photon and tiles (or switch to Ola/Google via the provider seam) when traffic grows | 23, scale | Open |
| R-91 | OpenStreetMap coverage of newer societies and small landmarks in Bengaluru can be patchy | M | L | Hosts drop a pin (not dependent on search results); customers can search by nearby landmark or use their location; switch provider if feedback shows gaps | 23 | Accepted |
| R-35 | AI introduced as a source of truth | L | H | Constitution rules (CLAUDE.md §21–22); tool-based architecture; authorisation tests | 22 | Mitigated (Phase 22: AI output can only fill public search filters; strict schema; no marketplace dependency; tests) |
| R-84 | Request text sent to an AI provider without a data-processing agreement; live model accuracy unmeasured | M | M | `AI_PROVIDER=none` (rules parser) until a DPA and key exist and `pnpm ai:eval` ≥ 90 %; redaction and minimal context meanwhile | 22, 23 | Open (owner action) |
| R-85 | Rules parser misreads unusual phrasing (e.g. ambiguous times, unknown landmarks) | M | L | Chips show what was understood; form stays editable; notes for unknown places; eval set grows from feedback patterns | 22 | Accepted |
