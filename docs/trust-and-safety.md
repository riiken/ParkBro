# Trust, Safety & Verification

Phase 4 output (2026-10-19). Defines verification, risk levels, fraud foundations, fake-listing prevention, on-site safety scenarios, liability defaults, location privacy, information visibility, access-credential security, the dispute lifecycle, enforcement and privacy compliance. This document finalises the visibility rules in [domain-model.md §7](domain-model.md#7-information-visibility-location-privacy-claudemd-11) and resolves D-018, UX-3, R-42 and R-43.

**Not legal advice.** Terms of service, liability allocation and DPDP compliance must be reviewed by counsel before launch (Phase 23).

---

## 1. Principles

1. **Risk-based and proportional (CLAUDE.md §10).** Everyone gets cheap baseline checks. Stronger verification is required only where risk justifies it, for example residential access, overnight or monthly stays, payouts or abuse signals.
2. **Layered.** No single control is relied on. Verification + booking-bound access + logging + reviews + reliability data + human review.
3. **Prevent, detect, respond, learn.** Every scenario in §7 has all four.
4. **Minimal data.** Collect only what a control needs. Store verification **results**, not raw documents, wherever the provider allows.
5. **Humans decide high-risk outcomes.** Rules and AI may flag or suggest. Suspensions, high-risk disputes and damage claims are decided by named admins (CLAUDE.md §18, §22).
6. **Honest promises.** We promise refund and rebooking when access fails (BR-24). We do **not** imply insurance we don't provide (§8).

---

## 2. Threat and abuse model

| Actor | Abuse / harm | Primary controls |
|---|---|---|
| Fake host | Lists a spot they don't control. Takes payment and never delivers. | Right-to-rent evidence, photo and geo checks, first-listing review, payout only after completion + dispute window (BR-18), recourse refunds |
| Host | Inaccurate listing (covered/open, size, charger power) | Photo requirements, reviews on accuracy, issue reports `LISTING_MISMATCH`, re-review on material change |
| Host | Cancels confirmed bookings, or double-sells off-platform | Cancellation penalties, reliability score, restriction ladder |
| Host | Self-booking to fake reviews or launder money | Same device, payment instrument or phone graph checks, reviews only from completed bookings |
| Customer | Credential sharing, entry outside the window, a different vehicle | Booking-bound, time-boxed codes bound to the plate (§10), guard check of the plate |
| Customer | Nuisance, theft or damage on premises; living or storing goods in a vehicle | Phone + risk-based ID, property rules, evidence capture, enforcement, prohibited-use terms |
| Customer | Refund abuse: false "can't get in" claims | Issue evidence, guard and access logs, host response, per-customer claim-rate signal |
| Customer | Payment fraud and chargebacks | Provider fraud tools, velocity limits, booking evidence for chargeback defence |
| Either | Harassment, off-platform solicitation, contact leakage | Masked calls and messages, contact-pattern warnings, block and report |
| Outsider | Scraping listings to find homes; enumeration of users or plates | Fuzzed locations, rate limits, non-sequential IDs, guard lookup needs the full plate and a property token |
| Outsider | Account takeover to redirect payouts | OTP + device signals, payout-detail change hold, notifications |
| Guard link holder | Probing which vehicles are where | Per-gate revocable tokens, rate limits, minimal responses, logging (§10.3) |
| Insider (admin) | Snooping PII, unauthorised refunds | Least-privilege roles, PII masked by default, reveal logging, audited actions, maker-checker for large refunds |

---

## 3. Verification catalogue

| Code | Subject | What | Method (pilot) | Stored |
|---|---|---|---|---|
| V-PHONE | User | Phone ownership | SMS / WhatsApp OTP, with rate limiting | Verified flag + time |
| V-EMAIL | User | Email ownership (receipts) | Magic link | Verified flag |
| V-ID | User | Real identity | Aadhaar **offline** verification (paperless e-KYC / Aadhaar Verifiable Credential via a registered OVSE provider) or DigiLocker document, **through a regulated KYC provider**. Never store the full Aadhaar number. | Provider reference, name, last-4, result, time |
| V-FACE | User | Selfie liveness + match to the ID photo | KYC provider (only when V-ID is required) | Result + score, no raw image beyond the provider's retention |
| V-VEHICLE-FMT | Vehicle | Plate format valid | Local validation (state code + series) | n/a |
| V-VEHICLE-RC | Vehicle | Plate exists, class and model plausible, RC active | Vahan-derived RC API via provider. **Owner-name match is not required** (family or company cars are common), but a mismatch is a soft signal. | Result, vehicle class, make/model, fuel type |
| V-PAYOUT | Host account | Bank / UPI account belongs to the host | Penny-drop / VPA name check, compared with the host or legal name | Masked account, name-match result |
| V-TAX | Host account | PAN (where tax rules require it) | PAN verification via provider (confirm the need with a CA, Phase 15) | Masked PAN, result |
| V-RIGHT | Asset / property | Right to rent this space | Attestation + evidence: ownership or lease document, allotment letter, owner authorisation letter (for tenants) | Evidence reference (protected), reviewer decision |
| V-SOCIETY | Property | Society consent | Committee resolution or letter on letterhead + verified contact of the office-bearer (phone OTP) + signed partnership terms | Documents (protected), signatory, terms version |
| V-PHOTO | Asset | Photos are real, current and of this space | In-app camera capture (no gallery for required shots), perceptual-hash duplicate check, server timestamps, admin review | Hashes, review result |
| V-GEO | Asset | Host was physically at the property | Device location at in-app photo capture compared with the geocoded address (soft check, tolerance ~150 m) | Distance, pass or fail |
| V-SITE | Asset / property | Physical inspection | Pilot field visit (first listings in a micro-market, flagged listings, all society properties) | Visit report |
| V-CHARGER | EV asset | Charger safety and suitability | Attestation: installed by a licensed electrician, earthing, RCD/MCB protection, cable condition; nameplate photo; connection type (domestic / EV-metered / commercial) | Attestation version, photos |

---

## 4. Risk levels and required verification

### 4.1 Customer requirements by booking risk

Booking risk is computed **deterministically** at quote time by rules (no ML in the pilot):

| Factor | Raises risk when |
|---|---|
| Property kind | `APARTMENT_SOCIETY` or `INDEPENDENT_HOUSE` (residential) |
| Time | The window overlaps 22:00–06:00 local |
| Duration | `MONTHLY`, or more than 24 h |
| Property policy | The society requires ID-verified customers |
| Customer history | New account (< 2 completed bookings), open restriction, abuse signal |

| Risk | Definition (pilot) | Customer must have |
|---|---|---|
| LOW | Commercial or office property, daytime, short-term, customer in good standing | V-PHONE, V-VEHICLE-FMT |
| MEDIUM | Residential **or** overnight **or** daily | + V-VEHICLE-RC |
| HIGH | Residential **and** (overnight or monthly), **or** the property requires it, **or** an abuse signal | + V-ID (+ V-FACE) |

If a requirement is missing, C-05 shows an inline "Verify to book this spot" step and explains why. Verification happens once and is reused.

### 4.2 Host requirements

| Milestone | Required |
|---|---|
| Create a draft | V-PHONE |
| Publish the first listing | V-RIGHT (or MEMBER_HOST approval in a participating society, BR-32), V-PHOTO, V-GEO (soft) + admin review (pilot: **all** first listings are human-reviewed) |
| Publish an EV listing | + V-CHARGER |
| Receive the first payout | V-PAYOUT, V-ID for individual hosts (or business documents for `BUSINESS`), V-TAX if required |
| Change payout details | OTP re-verification, V-PAYOUT again, 72 h payout hold + notification to all owners (R-17) |

### 4.3 Property (society) requirements
`PARTICIPATING` requires V-SOCIETY + V-SITE. The office-bearer becomes the first `PROPERTY_ADMIN`. A change of admin requires a new committee letter.

### 4.4 Asset publication review tiers
| Tier | When | Review |
|---|---|---|
| Full | First listing of a host; any residential listing in a new micro-market; EV listings; flagged hosts | Admin review + V-SITE where scheduled |
| Light | Additional commercial listings from a host in good standing | Automated checks + admin spot-check sample |
| Re-review | Material change (BR-23), reports, `LISTING_MISMATCH` issues ≥ 2 | Full |

---

## 5. Fraud detection foundation

**Pilot approach:** deterministic rules produce `RiskSignal`s. Signals above thresholds raise a `RiskFlag` into the admin queue (A-02/A-04). Admins apply `Restriction`s. No automated bans.

New conceptual entities (added to the domain model in Phase 6 schema design):
- `RiskSignal` (subject, kind, value, source, time)
- `RiskFlag` (subject, reason, severity, status `OPEN`, `REVIEWED_OK`, `ACTIONED`)
- `Restriction` (subject, kind such as `NO_NEW_BOOKINGS`, `NO_PUBLISH`, `PAYOUT_HOLD` or `SUSPENDED`, reason, starts, ends, decided_by)

| Signal | Rule (initial thresholds, configurable) |
|---|---|
| OTP abuse | > 5 OTP requests per phone per hour, or > 20 per IP per hour |
| Booking velocity | > 5 bookings created per customer per hour, or > 3 failed payments per hour |
| Cancellation pattern | Host cancels ≥ 2 confirmed bookings in 30 days. Customer cancels ≥ 5 in 30 days. |
| Recourse claim rate | Customer has ≥ 2 refunded `ACCESS_DENIED` / `UNIT_OCCUPIED` issues in 60 days without supporting guard or host evidence |
| Duplicate photos | Perceptual hash matches another host's asset photo, or a known web image |
| Duplicate location | New property within 30 m of an existing property owned by a different host (could be legitimate in a society; flag for review) |
| Shared payout account | The same bank account or VPA on more than one host account |
| Shared plate | A plate active under more than one user |
| Self-dealing | Customer and host share a device, payment instrument or phone |
| Contact leakage | A phone number, email or UPI ID pattern in listing text or messages before confirmation (warn and redact) |
| Chargebacks | Any chargeback raises a flag. ≥ 2 leads to `NO_NEW_BOOKINGS` pending review. |
| Geo mismatch | V-GEO fails on required photos |

Device signals are limited to a privacy-light device identifier (an app-generated install ID plus coarse fingerprint) disclosed in the privacy notice.

---

## 6. Fake-listing prevention (summary)

> **As built (Phase 9):** right-to-rent and charger-safety attestations (versioned wording) gate publishing; every upload is decoded and re-encoded to WebP (EXIF/GPS removed), near-duplicates of another host's photos are flagged for the reviewer (dHash, Hamming ≤ 6), optional capture location records a V-GEO distance, every submission is human-reviewed, and photo or location changes send a live listing back to review. Contact details are rejected in all public listing text.

1. **Capture:** required photos taken in-app (slot with surroundings, entrance or gate, charger nameplate for EV). Gallery uploads are allowed only for optional extras.
2. **Checks:** perceptual-hash dedupe, V-GEO, address geocode sanity check, V-RIGHT evidence, human first-listing review, V-SITE sampling.
3. **Money gate:** no payout until booking completion + dispute window. A fake host can't extract money before customers can complain.
4. **Feedback loop:** `LISTING_MISMATCH` issues and accuracy ratings feed re-review. Two confirmed mismatches pause the listing.
5. **Photo content rules:** public photos must not show house or flat numbers, building name boards (unless the society has opted to be named), faces or other cars' plates. Moderation blurs them or rejects the photo (also a location-privacy control, §9).

---

## 7. On-site safety scenarios

Each scenario: **prevent → detect → respond → evidence → default responsibility**. The responsibility defaults below are product defaults pending legal review of the Terms.

| Scenario | Prevent | Detect | Respond | Evidence | Default responsibility |
|---|---|---|---|---|---|
| **Customer no-show** | Reminders T-24 h / T-60 m | No check-in or entry by start + grace (BR-26) | `NO_SHOW`, unit released, refund per policy | Access events, no check-in | Customer |
| **Host no-show / unit unavailable** | Host blocks, reliability score, approval for monthly | BookingIssue `UNIT_OCCUPIED` / `HOST_UNREACHABLE` | Recourse: refund + rebook (BR-24), host penalty | Customer photo, timestamps | Host |
| **Unauthorised access** (code shared, wrong vehicle, outside the window, wrong slot) | Code bound to booking, plate and window; guard checks the plate | Guard lookup `DENIED`; host report | Deny entry. Repeat → restriction. Wrong-slot parking → host report + issue. | Access events, guard lookup log | Customer |
| **Overstay** | End − 15 min reminder; buffers | Exit event or host report after end + grace | `OVERSTAY` adjustment (BR-27); repeat → restriction; blocking the next booking → recourse for the next customer, charged back to the overstayer per Terms | Access log, host photo | Customer |
| **Property damage by customer** | ID for high-risk bookings, rules acknowledgement, check-in photo prompt | Host report within the dispute window | Dispute `PROPERTY_DAMAGE` (**HIGH**, human); customer restriction while open | Host photos, check-in photos, access log | Customer (per Terms) |
| **Vehicle damage / theft while parked** | Security attributes disclosed honestly; check-in photo prompt (customer's own record) | Customer report | Dispute `VEHICLE_DAMAGE` (**HIGH**); support helps with police or FIR guidance for theft | Check-in and check-out photos, access log | Fault-based; platform is not an insurer (§8) |
| **Charging damage** (charger or cable damaged by customer; EV damaged by a faulty charger) | V-CHARGER attestation; customer rules ("use only the provided cable…"); pilot EV hosts limited to non-domestic connections where possible (R-26) | `CHARGER_FAULTY` issue, host report | Stop the session, recourse refund, dispute (**HIGH** if damage claimed), listing paused pending inspection | Photos, session times | Fault-based |
| **Electrical / fire safety incident** | V-CHARGER; listing rules; no extension boards (rule) | Any report tagged as a safety incident | **Immediate:** "Call 112" prompt, support call-back, listing suspended, incident record, human investigation | All logs | Investigated case by case |
| **Personal safety** (customer or host feels unsafe, harassment) | Masked contact, lighting and guard attributes, reviews on safety | Report button on every booking screen | Always-visible "Emergency: call 112" + priority support line; account restriction pending review | Report, messages metadata | Investigated |
| **Prohibited use** (sleeping in a vehicle, storing goods, commercial loading, illegal activity) | Terms + rules acknowledgement at booking | Host or guard report | Booking cancellation per Terms, restriction, law enforcement where required | Reports, photos | Customer |
| **Society conflict** (resident complaints) | Society controls (caps, hours, approved hosts), guard visibility | Property admin report | Pause the asset or property; joint review with the society | Access log | Case by case |

**Evidence capture design:** optional prompted photos at check-in and check-out (C-12), taken in-app with server timestamps and linked to the booking. Required photos for damage claims at report time. Evidence is kept for the dispute window + 180 days, longer if disputed.

---

## 8. Liability and protection (pilot defaults)

- The platform operates as a **marketplace intermediary**. The Terms (counsel-drafted) state that the host is responsible for listing accuracy, lawful right to rent and safe premises, and the customer for their vehicle, conduct and damage they cause.
- **The pilot offers no platform insurance or host guarantee fund.** The UI and marketing must not imply one. The money we stand behind: full refunds for failed access and host cancellations (recourse) and for host-caused unavailability.
- **Goodwill credits:** admins may grant discretionary credits within configured caps (maker-checker above the cap), all audited.
- **Next step (post-pilot):** evaluate an insurer partnership (per-booking cover) and a deposit model for high-risk bookings once collection mechanics exist (Phase 15, Q-5).
- Disputes about damage are mediated with evidence. Where there's no agreement, the parties are pointed to legal remedies. The platform's decision governs platform money flows only (refunds, holds and credits).

---

## 9. Location privacy (final rules; resolves D-018)

| Rule | Detail |
|---|---|
| L-1 Public point | Each property gets a **stable** random offset applied once at creation: uniform bearing, distance 200–500 m (residential) or 0–100 m (commercial or office, where exactness helps and risk is low). Stored as the public point. Never recomputed per request. |
| L-2 Search and distance | All search, sorting and displayed distances use the public point. Distances are rounded to 100 m (shown as "~600 m"). Because the true point is never used in public queries, triangulation can only recover the public point. |
| L-3 Map display | Residential: a ~500 m radius circle, no pin. Commercial: pin allowed. |
| L-4 Text | Public area label = locality or neighbourhood only. No street, house or building names for `INDEPENDENT_HOUSE`. A participating society may opt in to show its name (it's a known partner, and outsiders are expected). |
| L-5 Photos | See §6 item 5. Entrance photo and access instructions are private (revealed after confirmation). |
| L-6 Reveal window | Exact address, geo pin, entrance photo, unit label and access instructions are visible to the booking's customer from `CONFIRMED` until end + 24 h, then hidden permanently from that customer. |
| L-7 Unit counts | Residential listings don't reveal how many units a property has, beyond "available" or not. |
| L-8 Host identity | Host first name and verification badges only. No surname, phone or flat number. |
| L-9 Testing (done in Phase 10: API, schema and rendered-page tests) | Phase 10 must include automated tests proving that no public endpoint returns the exact point, the address or the instructions. |

---

## 10. Access credential and guard security (resolves R-42, R-43, UX-3)

### 10.1 Credentials
- Per booking: a random 6-digit code (CSPRNG), **hashed at rest**, valid only within BR-25's window, and only for that property's lookups. A reissue revokes the old code.
- The QR (where used) encodes a signed, expiring token (booking ID + window + property), not the raw code.
- **Plate binding:** guard verification shows the expected plate. The guard checks the plate matches. A code alone doesn't grant entry to a different vehicle.
- "Share with driver" sends a time-limited link to C-12 for that booking only. It's revoked when the booking ends or is cancelled.

### 10.2 Offline cache (UX-3 decision: allowed, bounded)
- Only the **current and next** booking's credential and access details are cached on the device. They're encrypted with the platform's secure storage where available, deleted at window end + 24 h, on logout and on booking cancellation (on the next sync).
- Residual risk (a lost phone during an active booking) is acceptable: the credential is time-boxed and plate-bound, and the customer can revoke it from another device or through support.

### 10.3 Guard lookup surface (G-01)
- A **per-gate token** in the link (≥ 128-bit random). The property admin can rotate or revoke it (P-06). Tokens auto-expire every 90 days with a renewal prompt.
- Lookup requires the **full plate** or the **full code**. No partial search, no listing of expected vehicles on the guard link. The daily list goes to the property admin only.
- Rate limits per token (proposed 60 lookups/hour, 300/day) with lockout and alert to the property admin. SMS lookup accepted only from registered guard numbers.
- The response contains only: valid / not valid, slot label, valid-until time, expected plate (for a code lookup). No names, phones, prices or booking IDs.
- Every lookup is logged (token, input hash, result, time) and visible to the property admin (P-04).

---

## 11. Information visibility (final)

Legend: ✅ visible · ◐ partial or masked · ❌ never.

| Data | Public | Customer before booking | Customer after confirmation → end + 24 h | Customer after that | Host | Property admin | Guard | Platform admin |
|---|---|---|---|---|---|---|---|---|
| Public point, area label, photos (public set) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Exact address, pin, entrance photo | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ◐ reveal logged |
| Access instructions, unit label | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ◐ unit label only | ◐ reveal logged |
| Access credential | ❌ | ❌ | ✅ (own) | ❌ | ❌ | ❌ | ❌ (verifies only) | ❌ |
| Host name | First name | First name | First name | First name | n/a | ✅ (members) | ❌ | ✅ |
| Host phone | ❌ | ❌ | ◐ masked relay during booking | ❌ | n/a | ✅ (members) | ❌ | ◐ reveal logged |
| Customer name | ❌ | n/a | n/a | n/a | First name + last initial | ❌ | ❌ | ✅ |
| Customer phone / email | ❌ | n/a | n/a | n/a | ◐ masked relay | ❌ | ❌ | ◐ reveal logged |
| Vehicle plate | ❌ | n/a | n/a | n/a | ✅ during booking; masked 30 days after end | ✅ during booking; masked 30 days after end | ◐ verify, and shown on code lookup | ◐ reveal logged |
| ID documents / KYC data | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ result only; T&S role can view the provider reference |
| Payout account / PAN | ❌ | ❌ | ❌ | ❌ | ◐ masked (own) | ❌ | ❌ | ◐ finance role, masked |
| Reviews (published) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Access log | ❌ | ❌ | ◐ own events | ◐ own events | ✅ own assets | ✅ own property | ❌ | ✅ |

---

## 12. Communication safety
- All calls go through a masked relay (provider abstraction, Phase 18), active only from confirmation to end + 2 h.
- In-app messages are tied to a booking. Contact-detail patterns before confirmation are redacted with a warning (§5).
- Block and report are available on every conversation and booking. A report creates a `RiskFlag`.
- Staff never ask users for an OTP. This is stated in every OTP message.

---

## 13. Dispute lifecycle (refines domain-model §5.11)

### 13.1 Categories, risk and SLA

| Category | Risk | First response SLA | Decision by | Typical outcomes |
|---|---|---|---|---|
| Unavailable / access failure (post-booking, if recourse didn't resolve it) | MEDIUM | 24 h | Support (A1) | Refund, partial refund, host penalty |
| Incorrect listing | MEDIUM | 24 h | Support | Partial refund, listing re-review |
| Billing / overstay charge | LOW | 24 h | Support (rule-assisted) | Adjust, uphold |
| No-show contested | LOW | 24 h | Support | Reverse no-show, uphold |
| Host cancellation | LOW | 24 h | Rule-based (already full refund) + support | Penalty confirmation |
| Charger failure | MEDIUM | 24 h | Support | Refund, listing pause |
| **Vehicle damage** | **HIGH** | 4 h | Trust & safety (A2), named admin | Mediation, restriction, goodwill credit (capped) |
| **Property damage** | **HIGH** | 4 h | T&S | Mediation, restriction, payout hold |
| **Misconduct / safety** | **HIGH** | 1 h (safety first) | T&S | Suspension, law-enforcement referral |

### 13.2 Flow
1. **Open** (C-18 / host equivalent) within the window (BR-30: 72 h after end; safety reports have no window). Category, description and evidence are required for HIGH risk.
2. **Auto-attach** the booking timeline: transitions, payments, access events, issues, messages metadata, notifications.
3. **Hold:** the related host earnings are held (BR-30). For HIGH risk, the counterparty gets an optional temporary `Restriction`.
4. **Notify** the counterparty and request their response and evidence (`AWAITING_INFO`, 48 h).
5. **Review:** the assigned admin examines evidence. Rule-based or AI summaries are labelled **advisory** (CLAUDE.md §22).
6. **Resolve** with a written outcome, money movements (refund, credit, host receivable) and enforcement actions. All audited.
7. **Appeal:** one appeal per party within 7 days, reviewed by a different admin. Then `CLOSED`.

### 13.3 Enforcement ladder
`Warning → Restriction (time-boxed: NO_NEW_BOOKINGS / NO_PUBLISH / PAYOUT_HOLD) → Suspension → Permanent ban`. Safety-critical cases may jump straight to suspension. Every step has a recorded reason, the subject is notified, and one appeal is allowed. Reliability scores (Phase 19) take cancellations, recourse incidents, confirmed mismatches and dispute outcomes as inputs.

---

## 14. Privacy compliance (DPDP Act 2023 and DPDP Rules 2025)

The Rules were notified in November 2025, and most substantive obligations, including consent, notices and breach reporting, apply from around **May 2027** (verify exact dates with counsel). **We design to comply from day one** rather than retrofitting.

| Area | Design |
|---|---|
| Role | The platform is the data fiduciary. KYC, payment, SMS and maps providers are processors under contract. |
| Notice and consent | Itemised notice at signup (purpose per data category). Separate consent for location use and for V-ID. Consent records versioned. |
| Purpose limitation | Plates used only for access, verification and disputes. Location used only for search and verification. No sale or advertising use. |
| Minimisation | Results-only KYC storage. No full Aadhaar numbers. Masking per §11. |
| Retention (proposed defaults, confirm with counsel) | Access and audit logs ≥ 1 year (DPDP Rule 6 security logging). Booking and financial records per tax law (expected 8 years). KYC raw artefacts deleted by the provider after verification. Evidence: dispute window + 180 days unless disputed. Accounts closed → PII erased or anonymised except legally required records. |
| Rights | In-app access/export, correction, erasure request, grievance contact. Response SLAs per the Rules. |
| Security safeguards | Encryption in transit and at rest, field-level encryption for sensitive fields (address, plates, KYC references, payout details), RBAC, logging and monitoring, backups (Phase 5–7, 23) |
| Breach response | Playbook: contain → assess → inform affected users and the Data Protection Board without delay → detailed report to the Board **within 72 h** → remediate → review |
| Age | Users must be 18+ (drivers and hosts). An age attestation at signup. |
| Aadhaar | Only offline verification modes via a regulated provider, voluntary, with an alternative document accepted. No Aadhaar-based online e-KYC by the platform itself. |

---

## 15. Incident response (operational)
- **Safety incident:** support call-back within 5 minutes during pilot operating hours, a 112 prompt in-app, suspend the related listing or account pending review, incident record, follow-up within 24 h.
- **Data incident:** §14 breach playbook. On-call owner named before launch (Phase 23).
- **Payment incident** (mass failure or mismatch): reconciliation alert → pause payouts → finance review (Phase 15/16).

---

## 16. Implementation map

| Phase | Trust & safety work |
|---|---|
| 6 Database | `VerificationRecord`, `RiskSignal`, `RiskFlag`, `Restriction`, evidence storage references, field encryption, retention fields |
| 8 Identity | V-PHONE, rate limits, sessions, roles and admin permissions, PII masking and reveal logging |
| 9 Assets | V-RIGHT, V-PHOTO (in-app capture, hashing), V-GEO, V-CHARGER, first-listing review queue, photo moderation |
| 10 Discovery | L-1 to L-9 location privacy and its tests |
| 12 Booking | Booking risk computation (§4.1), verification gating at C-05 |
| 15–16 Payments / payouts | V-PAYOUT, V-TAX, payout holds, chargeback handling |
| 17 Access | Credential design (§10.1–10.2), guard surface security (§10.3), access logging |
| 18 Notifications | Masked relay, OTP messaging wording |
| 19 Reviews / disputes | §13 lifecycle, enforcement ladder, reliability inputs |
| 20 Admin | Queues, maker-checker, audit, PII reveal |
| 23 Launch | Terms and privacy review by counsel, incident on-call, breach drill |

V-ID, V-FACE and V-VEHICLE-RC use one KYC provider behind a `VerificationProvider` abstraction, chosen in Phase 5 or 8. They're needed only for HIGH-risk bookings and host payouts, so the cost stays proportional.

---

## 17. Open questions

| ID | Question | Default |
|---|---|---|
| TS-1 | Is V-ID mandatory for all individual hosts before the first payout? | Yes (money out = higher risk) |
| TS-2 | Pilot operating hours for safety support | 07:00–23:00 local, with the 112 prompt always available |
| TS-3 | Field visits (V-SITE) capacity in the pilot | All society properties + the first listing per host in each micro-market |
| TS-4 | Goodwill credit cap per case without second approval | ₹1,000 |
| TS-5 | KYC provider selection | Phase 5/8 evaluation (offline Aadhaar / DigiLocker, RC, penny-drop, PAN in one provider if possible) |

---

## Sources
- DPDP Rules 2025: [Mondaq](https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified), [Seclore compliance guide](https://www.seclore.com/fundamentals/dpdp-rules-2025-compliance-guide/), [TCSA implementation roadmap](https://www.tcsa.in/resources/dpdp-rules-2025-implementation-roadmap)
- Aadhaar offline verification: [UIDAI Authentication and Offline Verification Regulations 2021](https://www.uidai.gov.in/images/The_Aadhaar_Authentication_and_Offline_Verifications_Regulations_2021.pdf), [Vinod Kothari on 2025 face-matching](https://vinodkothari.com/2025/12/a-new-way-to-verify-aadhaar-offline-introduction-of-face-matching/), [Vinod Kothari on online authentication](https://vinodkothari.com/2025/05/online-authentication-of-aadhaar-exclusive-club-members-only/), [Delhi IT circular on OVSE](https://it.delhi.gov.in/sites/default/files/IT/circulars-orders/aadhaar_verification.pdf)
- RC verification: [HyperVerge RC verification](https://hyperverge.co/glossary/rc-verification-online-process), [Perfios](https://perfios.ai/resources/blogs/realtime-vehicle-rc-verification-for-banks-nbfcs/), [Surepass](https://surepass.io/blog/vehicle-owner-check-registration-number/)
