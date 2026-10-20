# UX Architecture

Phase 3 output (2026-10-19). Defines platform direction, navigation, screens, flows and how every domain state is shown to each audience, plus the loading, empty, error and confirmation states. This is architecture, not visual design. Visual design and the UI build come in Phase 7 and later.

Inputs: [core-user-journeys.md](core-user-journeys.md), [domain-model.md](domain-model.md) (state machines §5, visibility §7), [differentiation-strategy.md](differentiation-strategy.md) (recourse promise, monthly-first wedge), [user-personas.md](user-personas.md).

---

## 1. UX principles

1. **Certainty over cleverness.** Every screen answers "Is my spot guaranteed, what will I pay, and how do I get in?" Never say "booked" before the booking is `CONFIRMED`, and never say "paid" because of a client-side callback.
2. **The arrival moment is the product.** The access screen (C-12) and "I can't get in" recovery (C-13) get the most design attention. They must work one-handed, in a car, in sunlight, on a weak network.
3. **Ask only when needed.** Browse without an account. Ask for phone OTP and vehicle details at the moment of booking, inline, without losing context.
4. **Total price, always.** Search results and listing pages show the all-in total for the chosen time, with no "from ₹X" teasers. The fee breakdown is one tap away.
5. **Show privacy, explain it.** For residential listings an approximate area is shown with the label "Exact address shared after booking". Hosts see "Your address is hidden until a booking is confirmed".
6. **Every wait has words.** No spinner without text after 1 second. Long operations (payment confirmation) explain what's happening and what happens if it fails.
7. **Every failure has a next step.** Every error state offers a retry, an alternative or a human.
8. **Low-literacy and multilingual ready.** Icons with labels, plain language, short sentences, i18n from day one (English plus Hindi plus the pilot city's language). Guard-facing surfaces are local-language first.
9. **Accessible:** WCAG 2.1 AA, tap targets ≥ 44 px, colour never the only signal (state badges carry text), and support for screen readers and dynamic text size.

---

## 2. Platform direction (D-020, proposed)

**Mobile-first progressive web app (PWA) for the pilot**, one responsive codebase for customer, host and property admin, and a desktop-optimised platform admin console.

| Factor | PWA | Native app |
|---|---|---|
| Occasional visitor (C3) has no install friction | ✅ open a link from search, WhatsApp or SMS | ❌ install barrier at the moment of need |
| Locality landing pages for SEO and acquisition | ✅ | ❌ |
| Guard lookup without installing an app | ✅ the same web stack | n/a |
| One codebase for a small team | ✅ | ❌ two platforms, or a cross-platform framework |
| Push notifications | ⚠️ Android yes; iOS only when installed to home screen (iOS 16.4+) | ✅ |
| Background location / geofenced arrival | ❌ | ✅ |
| Camera (evidence photos), maps, UPI intent deep links | ✅ | ✅ |

**Consequences:**
- Critical notifications (confirmation, reminders, access details, issue updates) go through **WhatsApp and SMS** (Phase 18). Push is a bonus, never the only channel.
- Arrival is **manual check-in** or a guard or adapter verification. There's no geofencing.
- Revisit native when the pilot shows repeat customers (monthly) wanting push or geofenced arrival. The API-first backend (Phase 5) keeps that option cheap.

---

## 3. Navigation

### 3.1 One account, two modes
A single `User` can hold several roles (domain-model §3.1). Users with a `HostAccount` see a **"Switch to hosting"** control in Account. Hosting mode has its own navigation. Property admins and guards use separate, scoped surfaces.

### 3.2 Customer navigation (bottom tabs)

```
[ Search ]   [ Bookings ]   [ Help ]   [ Account ]
```
- **Search:** home, results, listing. The default tab.
- **Bookings:** "Now / Upcoming" pinned at top (with the access entry point), then monthly plans, then past.
- **Help:** issue entry for an active booking, FAQs, contact support.
- **Account:** profile, vehicles, payments and receipts, verification, language, "Switch to hosting" / "Become a host".

A booking that's **in its access window** shows a persistent banner on every customer screen: "Your spot at Koramangala starts in 12 min → Get in".

### 3.3 Host navigation (hosting mode)

```
[ Today ]   [ Calendar ]   [ Listings ]   [ Earnings ]   [ More ]
```
- **Today:** actions needed (approvals, open issues with a timer, notices), today's arrivals and departures.
- **Calendar:** per listing and unit, bookings, blocks and availability. Block time here.
- **Listings:** list, create, edit, publish and pause.
- **Earnings:** pending, available, paid, payouts, payout account.
- **More:** reviews, verification, host account members, help, switch to customer mode.

An **open BookingIssue** on the host's listing overrides everything: a full-width alert with the countdown to automatic recourse (BR-24).

### 3.4 Property admin (web, mobile-friendly)
`Overview · Hosts · Policy · Access log · Statements`

### 3.5 Guard surface (no app, no account)
A property-scoped secure link (and SMS / WhatsApp equivalents) opening **one screen**: lookup by vehicle number or booking code. Details in §6.

### 3.6 Platform admin console (desktop web)
`Search · Queues (Verification, Issues, Disputes, Payout holds) · Bookings · Users & Hosts · Properties & Assets · Finance · Config · Audit log`
Every item is permission-gated (A1–A4 roles). Every mutation asks for a reason and is audit-logged.

---

## 4. Customer screens and flows

### 4.1 Screen inventory

| ID | Screen | Purpose | Key states |
|---|---|---|---|
| C-01 | Home / Search | Destination (place search or current location), when (start/end, or "Monthly from [date]"), vehicle (if known) | First-run with no vehicle: ask vehicle class inline |
| C-02 | Results (list ⇄ map) | Available assets for the exact window: total price, walking distance from destination, key badges (Covered, CCTV, Guard, EV Type 2 7.4 kW), rating, reliability badge | Loading skeleton; **empty** (see §8.2); partial (few results → suggest wider radius or time) |
| C-03 | Filters | Parking: price, distance, covered, security, EV-ready, vehicle size. EV: connector (pre-filtered to the vehicle's), AC/DC, min kW, price. | Shows the result count live |
| C-04 | Listing detail | Photos, approximate area map, what's included, rules, vehicle fit, host reliability, reviews, cancellation policy in plain words, **total for the selected time**, CTA | Unavailable for selected time → show next available windows |
| C-05 | Review & book | Quote breakdown, vehicle, policy summary, CTA "Pay ₹X" or "Request to book" (approval assets). Inline OTP login (C-06) and add vehicle (C-07) if missing. | Quote expired → silent re-quote; price changed → explicit notice |
| C-06 | Phone OTP (inline sheet) | Login or registration | Wrong code, resend timer, rate limited |
| C-07 | Add vehicle (inline sheet) | Plate, class, EV connector(s) | Plate format validation; duplicate plate → support path |
| C-08 | Payment (provider checkout / UPI intent) | Hand-off to the payment provider | Cancelled, failed, app-switch return |
| C-09 | Confirming payment | Shown after return from the provider until a verified result arrives | §8.3 |
| C-10 | Booking confirmed | Success, then reveal: exact address, entrance photo, unit label, access method and credential, "Add to calendar", "Share with driver" | |
| C-11 | Booking detail | State-driven (see §7): times, price, receipt, access, cancel, help | One layout, content per state |
| C-12 | **Get in (access)** | Big credential (code / plate / QR), navigate button, entrance photo, slot label, "I'm here" check-in, **"I can't get in"** | Before window: countdown. Window open. After entry: "You're parked, ends 19:00". |
| C-13 | **I can't get in (issue)** | Pick reason (guard refused, spot occupied, charger not working, can't find, host not responding), optional photo, submit → live status with countdown | §5.2 |
| C-14 | Cancel booking | Refund preview from the snapshot policy, confirm | Non-refundable warning; idempotent confirm |
| C-15 | Monthly plan | Current period, next renewal date and amount, payment status, give notice, vehicle change request | `PAST_DUE` banner with pay CTA |
| C-16 | Bookings list | Now/Upcoming, Monthly plans, Past | Empty: "No bookings yet" + Search CTA |
| C-17 | Review | Rate host and listing on dimensions, text | Shown after completion; the window countdown |
| C-18 | Dispute | Category, description, evidence upload, timeline of status | §5.3 |
| C-19 | Account | Profile, vehicles, receipts, verification, language, hosting switch | |
| C-20 | EV session panel (inside C-11/C-12 for EV bookings) | "Start charging" / "Stop" (self-reported), "Charger not working" → C-13 | `FAULTED` → issue flow |

### 4.2 Core flow: short-term booking (target: ≤ 4 screens from listing to confirmed)

```
C-01 Search ─▶ C-02 Results ─▶ C-04 Listing ─▶ C-05 Review & book
                                                  │  (inline C-06 OTP, C-07 vehicle if needed)
                                                  ▼
                                   C-08 Payment ─▶ C-09 Confirming ─▶ C-10 Confirmed ─▶ C-12 Get in
```
- If the unit was taken between C-04 and C-05 (BR-07): show **"Just booked by someone else"** with the 3 nearest alternatives for the same window. Never show a generic error.
- The hold timer (BR-10) is shown only if it gets under 3 minutes ("Complete payment within 2:45 to keep this spot").

### 4.3 Monthly flow
`C-01 (Monthly from [date]) → C-02 → C-04 (shows monthly price, notice period, renewal terms) → C-05 "Request monthly spot" (approval default, D-017) → "Request sent: host usually responds within X h" → host approves → notification → C-05 payment → C-10`.
After confirmation, C-15 becomes the home of the arrangement.

### 4.4 EV flow
Search with an EV vehicle **auto-filters to compatible connectors** (BR-12) and labels each result with "Fits your [car]: Type 2, 7.4 kW AC, ~X h to 80%" (estimate clearly labelled as an estimate, never a promise). Pricing shows per hour or per session explicitly. C-20 is used on arrival.

---

## 5. Recovery flows (the trust promise)

### 5.1 Arrival timeline (C-12)

```
 T-24h     T-60m         T-15m (window opens)      start           end    end+grace
   │ reminder│ reminder +   │ C-12 "Get in" active   │                │        │
   │ (WA/SMS)│ access details│ guard lookup valid    │ "I'm here"     │ reminder│ overstay
```

### 5.2 "I can't get in" (BookingIssue, BR-24)

```
C-13 pick reason ─▶ submitted ─▶ "We've alerted the host. If it isn't fixed in 15:00,
                                   you'll get a full refund automatically."
        │                         [Call host (masked)]  [Add photo]  [It's fixed]
        ├── host resolves ────────▶ "Host says it's resolved: are you in?" [Yes] [No → continue]
        ├── timer ends ───────────▶ "Refund of ₹X started" + 3 nearby alternatives [Book]
        └── safety concern ───────▶ "Call support now" (always visible)
```
Customer-side states map to `OPEN`, `HOST_NOTIFIED`, `RESOLVED_ON_SITE`, `REBOOKED`, `REFUNDED`, `ESCALATED` (§7.6).

Host side (H-08): full-screen alert, the same countdown, actions **Call customer**, **Tell guard / Resolve**, **I can't fix it** (immediately triggers refund and recourse; reliability impact shown honestly).

### 5.3 Disputes
Entry: from a past booking (within the window, BR-30) or escalated from an issue. The timeline shows each status with expected response times. High-risk categories (damage, safety, misconduct) show "A member of our team will review this personally".

---

## 6. Guard surface (G-01)

```
┌──────────────────────────────┐
│  Sunrise Apartments · Gate 1 │   ← property-scoped link, language toggle
│  ┌────────────────────────┐  │
│  │ KA 01 AB 1234          │  │   ← plate or 6-digit code; large keypad
│  └────────────────────────┘  │
│        [ CHECK ]             │
│                              │
│  ✅ VALID NOW                │   or  ❌ NOT VALID: no booking right now
│  Slot B2-14 · until 19:00    │        [Call host]  [Call support]
│  [ Allow entry ]             │   ← records ENTERED AccessEvent
└──────────────────────────────┘
```
- Shows **only**: valid or not, slot label, end time. No customer name, phone or price (domain-model §7).
- The link is per-property and revocable, and rate-limited (Phase 17 security).
- SMS / WhatsApp equivalent: send `CHECK KA01AB1234`, get `VALID B2-14 till 19:00` or `NOT VALID`.
- Fallback: a daily expected-vehicle list for the property admin to print or share (P-01).
- Where the society uses MyGate, NoBrokerHood or ADDA, the booking becomes a visitor pre-approval through the adapter (D-011), and G-01 is the fallback.

---

## 7. State presentation

Every domain state has a defined label, badge and primary actions. Labels are user-facing copy (to be localised). Internal state names never appear in the UI.

### 7.1 Booking (domain-model §5.3)

| State | Customer sees | Customer actions | Host sees | Host actions |
|---|---|---|---|---|
| `AWAITING_HOST_APPROVAL` | "Request sent: waiting for host" + expiry time | Cancel request | "New request: respond by HH:MM" | Approve, Decline |
| `PENDING_PAYMENT` | "Complete payment to confirm" (+ timer under 3 min) | Pay, Cancel | Not shown (not yet a booking) | n/a |
| `CONFIRMED` | "Confirmed" + start countdown; access shown from window start | Get in, Cancel (refund preview), Help | "Confirmed: arriving HH:MM" | Message (masked), Cancel (with penalty warning) |
| `IN_PROGRESS` | "You're parked: ends HH:MM" | Report problem, Extend (future), Help | "In use until HH:MM" | Report problem |
| `COMPLETED` | "Completed" + receipt | Review, Dispute (within window) | "Completed: earnings pending" | Review, Dispute |
| `CANCELLED` | "Cancelled by you / host / us": refund amount and status | Book again, Help | "Cancelled by …" + impact | n/a |
| `EXPIRED` | "Not confirmed: payment wasn't completed. You weren't charged." (or "refund on its way" for late success, BR-15) | Try again | Hidden | n/a |
| `DECLINED` | "Host couldn't accept: here are similar spots" | Alternatives | "Declined" | n/a |
| `NO_SHOW` | "Marked as no-show" + policy | Dispute | "Customer didn't arrive" | n/a |

### 7.2 Payment (§5.5)

| State | Customer copy |
|---|---|
| `CREATED` / `PENDING` | "Waiting for payment confirmation from your bank/UPI app…" |
| `SUCCEEDED` | "Payment received" (shown only on server-verified state) |
| `FAILED` | "Payment didn't go through. No money was taken. If it was, it'll be refunded automatically within N days." [Try again] |
| `EXPIRED` | "Payment window closed. Start again to book." |
| Refund `PENDING` / `SUCCEEDED` / `FAILED` | "Refund of ₹X started: usually reaches you in N working days" / "Refunded ₹X on DATE" / "Refund delayed: we're on it" (support notified) |

### 7.3 Cancellation (customer-initiated)
1. C-14 shows **exactly** what they'll get back: "Cancel now: ₹180 refund (full). After 08:00 tomorrow: ₹90 (50%)."
2. Confirm → "Cancelled. ₹180 refund started." Idempotent: a double tap doesn't cause double processing.
3. Host-initiated cancel (H-07): the warning names the consequence ("Customer gets a full refund. This counts against your reliability.") and asks for a reason.

### 7.4 Monthly series (§5.4)

| State | Customer | Host |
|---|---|---|
| `ACTIVE` | "Active: renews DATE for ₹X" | "Active monthly: next payout DATE" |
| `PAST_DUE` | Banner: "Renewal payment failed: pay by DATE to keep your spot" [Pay] | "Renewal pending: spot held until DATE" |
| `NOTICE_GIVEN` | "Ending DATE (notice given by you/host)" | Same |
| `ENDED` | "Ended DATE" | Same |

### 7.5 Access grant (§5.7)
`ISSUED` → "Access details unlock at HH:MM" · `ACTIVE` → the credential shown large · `USED` → "Entered at HH:MM" · `EXPIRED` → hidden, "Booking ended" · `REVOKED` → "Access cancelled", with the reason category.

### 7.6 Booking issue (§5.8)
`OPEN` / `HOST_NOTIFIED` → countdown screen (§5.2) · `RESOLVED_ON_SITE` → "Resolved" · `REBOOKED` → the new booking card · `REFUNDED` → refund status · `ESCALATED` → "Support is handling this" + case number.

### 7.7 Charging session (§5.9)
`NOT_STARTED` → "Plug in, then tap Start" · `CHARGING` → "Charging since HH:MM: booking ends HH:MM" · `COMPLETED` → "Done" · `STOPPED_EARLY` → "Stopped at HH:MM" · `FAULTED` → issue flow (C-13 preselected "Charger not working").

### 7.8 Asset (host, §5.1)
`DRAFT` → "Draft: N steps left" · `PENDING_REVIEW` → "In review: usually within 24 h" · `PUBLISHED` → "Live" · `PAUSED` → "Paused: not taking new bookings" · `SUSPENDED` → "Suspended: [reason], contact support" · `ARCHIVED` → in the archive list. A blocked publish (for example society consent missing) lists **exactly** what's missing.

### 7.9 Property participation (§5.2)
For hosts in a society: `CONSENT_REQUIRED` → "Your society hasn't joined yet. You can prepare your listing. [Invite your society committee]" · `PENDING_CONSENT` → "Society onboarding in progress" · `PARTICIPATING` → normal · `SUSPENDED` / `WITHDRAWN` → explanation plus what happens to existing bookings.

### 7.10 Payout and earnings (§5.6)

| Earnings bucket | Host copy |
|---|---|
| `PENDING` | "Pending: booking in progress" or "Pending: dispute window until DATE" (always with the reason) |
| `AVAILABLE` | "Available: in the next payout on DATE" |
| `IN_PAYOUT` | "In payout #N" |
| `PAID` | "Paid on DATE to ••••1234" |

| Payout state | Host copy / action |
|---|---|
| `SCHEDULED` | "Scheduled for DATE: ₹X" |
| `PROCESSING` | "Sending to your bank" |
| `PAID` | "Paid ₹X on DATE" + statement |
| `FAILED` | "Payout failed: check your bank details" [Update] |
| `ON_HOLD` | "On hold: [reason, for example payout details changed recently / open dispute]. Releases DATE or when resolved." |

A negative balance (host receivable, BR-19) shows as "₹X will be deducted from your next payout" with the linked booking.

### 7.11 Review (§5.10)

| State | Author sees | Others see |
|---|---|---|
| `ELIGIBLE` | "Rate your experience: N days left" | n/a |
| `SUBMITTED` | "Submitted: appears when [other party] reviews or on DATE" | Hidden |
| `PUBLISHED` | Published review | Public on the listing or profile |
| `LAPSED` | Prompt removed | n/a |
| `REMOVED` | "Removed for breaking review guidelines" (author only) | Hidden |

### 7.12 Dispute (§5.11)

| State | Party copy |
|---|---|
| `OPEN` | "Dispute received: case #N. We'll respond within X h." |
| `UNDER_REVIEW` | "Our team is reviewing" (HIGH risk: "reviewed personally by our team") |
| `AWAITING_INFO` | "We need [item] from you by DATE" [Upload] |
| `ESCALATED` | "Escalated to a senior specialist" |
| `RESOLVED` | Outcome in plain words plus every money movement (refund, deduction) with dates |
| `CLOSED` | "Case closed" + link to the decision |

### 7.13 Cancellation reason copy

| `cancelled_by` / reason | Customer copy | Host copy |
|---|---|---|
| `CUSTOMER` | "You cancelled: ₹X refund" | "Customer cancelled" (+ any retained amount) |
| `HOST` | "The host cancelled. Full refund of ₹X started. Here are similar spots." | "You cancelled: counts against reliability" |
| `PLATFORM` | "We cancelled this booking: [reason category]. Full refund." | "Cancelled by [brand]: [reason category]" |
| `RECOURSE_ACCESS_FAILURE` and other `RECOURSE_*` | "Couldn't get you in: full refund of ₹X started" + alternatives | "Auto-cancelled: issue not resolved in time" |

---

## 8. Cross-cutting state patterns

### 8.1 Loading
- Lists and results: skeleton cards, never a blank screen.
- Actions (book, cancel, approve): the button switches to a progress state with a verb ("Cancelling…"). It's disabled to prevent double submit, and the idempotency key protects the server anyway.
- After 8 s on any network call: "Still working: slow connection" plus the option to keep waiting.

### 8.2 Empty
| Context | Message and next step |
|---|---|
| No results | "No spots free near [place] for [time]." Offer: widen radius (shows count), shift time ±1 h (shows count), "Get notified when a spot opens here" (captures demand: the zero-result search metric) |
| No bookings | "No bookings yet" + Search |
| Host: no listings | "List your first spot: takes about 10 minutes" + start wizard |
| Host: no bookings yet | Tips to improve the listing (photos, price vs nearby) |
| No reviews | "New on [brand]" badge, not "0 stars" |
| Admin queues empty | "All clear" |

### 8.3 Payment confirmation wait (C-09)
1. Shows "Confirming your payment…" while polling the server's booking state (never the client callback).
2. At 30 s: "Your bank is taking longer than usual. You can leave this screen; we'll message you on WhatsApp/SMS when it's confirmed."
3. Server outcome `CONFIRMED` → C-10. `EXPIRED` + late success → "Payment received after your hold expired" + either confirmed (unit still free) or "refund started" (BR-15).

### 8.4 Errors

| Class | Example | UX |
|---|---|---|
| Validation | Plate format, time range invalid | Inline at the field, in plain language |
| Conflict / stale | Spot taken, price changed, listing paused | Explain plus the best alternative. Never a generic error. |
| Payment | Failed, cancelled | §7.2 copy + Try again |
| Unauthorised / expired session | OTP session expired | Re-login sheet that **returns to the same step** with inputs preserved |
| Forbidden | Accessing someone else's booking | "This booking isn't on your account" + Home |
| Offline / network | Weak signal in a basement | Cached access credential for **current and upcoming** bookings stays visible offline (C-12). Actions queue a clear retry. |
| Server | 5xx | "Something went wrong on our side" + Retry + request ID (for support) |
| Rate limited | OTP resend | Countdown before the next attempt |

### 8.5 Confirmation and success
- Irreversible or money actions need explicit confirmation that states the consequence: cancel, host cancel, decline, give notice, change payout account, admin refunds and suspensions.
- Success screens state what happened **and what happens next** ("Refund started: reaches you in 5–7 working days").

---

## 9. Host screens and flows

| ID | Screen | Notes |
|---|---|---|
| H-01 | Today | Action cards in priority order: open issues (timer) → approvals (deadline) → notices → today's arrivals |
| H-02 | Create listing wizard | 1) Property (address private; society or house or commercial) → 2) Type (Parking / EV charging) → 3) Details (type-specific) → 4) Photos (slot, entrance, charger; guided) → 5) Spots (single or N identical; labels) → 6) Availability (weekly schedule presets: "Weekdays 9–7", "Nights", "Always") → 7) Pricing (per enabled mode, with nearby range guidance) → 8) Rules & access instructions (private) → 9) Review & submit. **Autosaves as `DRAFT`** at every step. |
| H-03 | Listings | Status badges (§7.8), quick pause and resume |
| H-04 | Listing editor | Edits to material fields warn "This will send your listing for review again" (BR-23) |
| H-05 | Calendar | Units × days. Bookings (read-only), blocks (add/remove), availability. Blocking an occupied slot is refused with "Cancel the booking instead?" (BR-04) |
| H-06 | Requests | Approve / decline with customer trust info (verification, completed bookings, rating), never contact details |
| H-07 | Booking detail (host) | Customer first name, vehicle plate and class, times, unit, earnings breakdown, masked call, cancel (with consequence) |
| H-08 | Issue response | §5.2 |
| H-09 | Earnings | Buckets (§7.10), per-booking breakdown: gross, commission, fees and taxes, society share, net |
| H-10 | Payouts & account | History, schedule, payout account (change → re-verification + hold notice) |
| H-11 | Monthly arrangements | Active series per unit, renewal status, give notice |
| H-12 | Reviews | Received and given, pending |
| H-13 | Verification | What's verified, what's needed and why (risk-based, Phase 4) |
| H-14 | Team (business hosts) | Invite manager. Owner-only payout control. |

**Host onboarding target:** a publishable listing in ≤ 10 minutes for a single slot with photos ready.

---

## 10. Property admin screens

| ID | Screen | Notes |
|---|---|---|
| P-01 | Overview | Today's expected outsider vehicles (plate, slot, window), **live count vs cap** (BR-06), recent access events, printable/shareable daily list |
| P-02 | Policy | Allowed hours, cap, vehicle classes, booking modes, approval requirement, guard method. Saving creates a new version, with the note "Applies to new bookings" (snapshot rule). |
| P-03 | Hosts | Resident host requests (approve or reject → `MEMBER_HOST`), active hosts, suspend |
| P-04 | Access log | Filterable entries (plate masked after the retention period), denied attempts highlighted |
| P-05 | Statements | Society revenue share per period |
| P-06 | Guard access | Generate or revoke guard links, SMS numbers, language |
| P-07 | Participation | Pause participation / withdraw, with an impact preview (affected bookings, §5.2) |

---

## 11. Platform admin console

| ID | Screen | Notes |
|---|---|---|
| A-01 | Global search | By booking ID, phone, plate, host, property, payment ID. Results respect admin permissions. PII is revealed on explicit click and logged. |
| A-02 | Verification queue | Listings, hosts, properties, right-to-rent and society consent evidence. Approve or reject with a reason. |
| A-03 | Booking timeline | One chronological view: booking transitions, payments and webhooks, access events, issues, messages metadata, notifications, admin actions |
| A-04 | Issues & disputes queue | Sorted by risk and SLA. `HIGH` risk requires a named admin decision (BR-31). Suggested actions are labelled as suggestions. |
| A-05 | Finance | Reconciliation mismatches, refunds, payout runs (approve), holds, host receivables |
| A-06 | Users & hosts | Status, verification, trust signals, restrict or suspend (with reason) |
| A-07 | Properties & assets | Participation status, policies, suspend listings |
| A-08 | Configuration | Versioned commission, fees, timeouts, grace windows, cancellation policies. Changes show the effective time and need confirmation. |
| A-09 | Audit log | Every admin action and sensitive data view |

---

## 12. Notification touchpoints (channels designed in Phase 18)

| Moment | Customer | Host | Property / guard |
|---|---|---|---|
| Booking request | | ✅ (approve by deadline) | |
| Confirmed | ✅ with access-reveal link | ✅ | ✅ if a society adapter is active |
| T-24 h / T-60 m | ✅ reminder + access details | T-60 m arrival notice | Daily expected list |
| Issue opened | ✅ status | ✅ **urgent, repeated until acknowledged** | |
| Issue auto-resolved | ✅ refund + alternatives | ✅ outcome | |
| End − 15 min | ✅ | | |
| Payment, refund, payout | ✅ | ✅ payout | |
| Monthly renewal (T-5 d, failure, grace end) | ✅ | ✅ | |
| Review window | ✅ | ✅ | |

---

## 13. Information architecture and privacy rules in the UI
- Before booking, residential listings show a **circle around the fuzzed point**, never a pin, plus the label "Exact location after booking". Commercial and office listings may show a pin ([trust-and-safety.md §9](trust-and-safety.md#9-location-privacy-final-rules-resolves-d-018) L-3).
- Revealed details (C-10, C-12) are hidden again after end + 24 h (domain-model §7). The booking detail shows "Address no longer shown" afterwards.
- Hosts never see customer phone numbers or emails. "Call" goes through a masked relay.
- Screenshots and sharing: "Share with driver" sends a time-limited link, not the raw code.
- Admin PII is masked by default, and reveals are logged (A-01, A-09).

---

## 14. UX metrics (inputs to Phase 21)
- Search → listing view → booking start → confirmed funnel; zero-result search rate.
- Median time from listing view to confirmed booking.
- Payment confirmation time (C-09 duration) distribution.
- Access success rate; BookingIssue rate per 100 bookings; median issue resolution time; share resolved on site vs refunded.
- Host: wizard completion rate and time to publish; approval response time.
- Monthly: renewal success rate; `PAST_DUE` recovery rate.

---

## 15. Journey traceability

| Journey ([core-user-journeys.md](core-user-journeys.md)) | Screens |
|---|---|
| CJ-1 Short-term booking | C-01 → C-05, C-06–C-10 (§4.2) |
| CJ-2 Monthly | C-01, C-04, C-05, C-15, H-06, H-11 (§4.3) |
| CJ-3 EV charging | C-02/C-03 connector filter, C-20 (§4.4) |
| CJ-4 Arrival and access | C-12, C-13, G-01, H-08 (§5, §6) |
| CJ-5 Cancel / modify | C-14, H-07 (§7.3) |
| CJ-6 End, overstay, early exit | C-12 post-entry state, end − 15 min notification (§12) |
| CJ-7 Dispute | C-18, A-04 (§5.3, §7.12) |
| CJ-8 Review | C-17, H-12 (§7.11) |
| HJ-1 Onboard and list | H-02, H-13 |
| HJ-2 Availability and pricing | H-05, H-04 |
| HJ-3 Receive and manage bookings | H-01, H-06, H-07 |
| HJ-4 Host cancellation | H-07 (§7.3) |
| HJ-5 Earnings and payout | H-09, H-10 (§7.10) |
| PJ-1 Society onboarding | P-02, P-03, P-07, host-side §7.9 |
| PJ-2 Guard verification | G-01, P-06, P-01 daily list |
| AJ-1 Verification | A-02 |
| AJ-2 Support and disputes | A-01, A-03, A-04 |
| AJ-3 Finance and payouts | A-05 |

## 16. As built (Phase 10)
- C-01/C-02/C-03 are combined into one search page: place autocomplete or "use my location", parking or EV, booking type, optional date and times (IST), filters, sort, "Show more" paging, an empty state with "Search within 10 km", and inline errors. There's no map until the maps vendor is chosen (AR-3). Results are a list.
- C-04 listing page is server-rendered from the public API: photos, facts, charger, weekly schedule, rules, prices, host first name, "approximate area" notice for residential, and a disabled "Booking opens soon" button (Phase 12/13).

## 16b. As built (Phase 13)
- **Customer:** the booking box offers every mode the listing prices: hourly, daily (N days), overnight (the listing's window) and monthly ("Request monthly spot", host approval). The search window prefills it. "Just booked / not available" offers "See other spaces nearby". Bookings list has a **Monthly plans** section; C-15 plan page shows months, next renewal, past-due and notice states, and "Give notice". Single bookings of a running plan can't be cancelled (notice instead).
- **Host (H-01, H-02/H-04, H-03, H-05, H-06/H-07, H-11):** `/host` Today (requests with approve/decline and deadlines, next 48 h arrivals, drafts), Listings, create (property: private address, public area, device location or area centre; title), editor with one save per section (space, spaces, photos, prices per mode incl. overnight window, weekly schedule presets or custom, description/rules/private access, booking settings, right-to-rent confirmation) driven by the server checklist, then Submit / Pause / Publish again / Archive. Calendar: day view per space (free, booked incl. turnover, blocked) with add/remove block. Bookings grouped by Requests / Upcoming / Past with detail actions. Monthly plans with notice.
- Not yet: map picker (AR-3), earnings (Phase 16), EV listing screens (Phase 14), host trust info on requests (Phase 19), multi-day calendar grid.

## 16c. As built (Phase 14)
- **Driver:** listing shows speed class (slow / fast AC / rapid DC), connectors, power and cable; the booking box books charging sessions (min/max length from the listing); adding a vehicle from an EV listing defaults to EV with a connector; search preselects the connector of the driver's EV ("Showing chargers that fit …"). C-20 panel on the booking: "Plug in, then tap Start" → "Charging since HH:MM" → Stop; "Charger not working?" with reasons; energy shown only when metered, plus a clearly labelled estimate.
- **Host:** choose Parking or EV charging when creating; the editor adds the charger section (connectors, AC/DC, kW, connection, cable), the charger photo, a per-hour or per-session charging price, and the charger safety confirmation. Host booking detail shows the session read-only.

## 16d. As built (Phase 15)
- C-05/C-08/C-09: a held booking shows "Pay ₹X"; Razorpay checkout opens in its frame (or, in development, a clearly labelled test checkout with "Complete test payment" / "Simulate a failed payment"); then "Waiting for payment confirmation from your bank or UPI app…" until the server-verified result. Failure copy: "Payment didn't go through… No money was taken; if it was, it will be refunded automatically." Confirmed bookings reveal access as before (L-6). Refund status is listed with the booking's payments.

## 16e. As built (Phase 16)
- H-09/H-10 `/host/earnings`: balances (pending with the 48 h release rule, available, being paid out, paid, owed back), payout account (UPI or bank; masked; "Being verified"; 72 h pause after a change; owner only), per-booking lines (gross, commission, tax, customer fee "not yours", refunds, net, pending/released), payout history with bank reference. Host booking detail links to earnings.

## 16f. As built (Phase 17)
- C-12 "Get in" on the booking: large 6-digit code, plate, space, window; "I'm here", "Share with driver" (system share sheet or copy), "New code". C-13 "I can't get in": reason + note; then "The host has been asked to fix it by HH:MM. If it isn't fixed by then, you get a full refund automatically" with "It's sorted now" / "Still stuck: contact support". In-progress shows "You're parked". A refunded issue explains what happened and links to search.
- `/pass/{token}` driver pass; `/gate/{token}` guard page (G-01: one field, big verdict, expected plate, "Allow entry").
- Host: Today puts "Customers who can't get in" first; booking detail has "Fixed on site" / "Ask support to help" and "Report no-show" when allowed; `/host/gates` for guard links and the access log.

## 16g. As built (Phase 18)
- `/inbox` lists every notification (critical ones marked), opens its link and marks it read; "Mark all read". Account has WhatsApp/SMS toggles with the note that urgent messages always go by SMS. Copy for each message is in `notifications/domain/templates.ts`.

## 16h. As built (Phase 19)
- Completed bookings show a review form (customers: rating + optional dimensions + comment; hosts: rating + comment) with "hidden until both reviews are in"; the other side's review appears once published. Listing pages show reviews (average from 3).
- "Report a problem with this booking" (in progress, completed, cancelled, no-show) → category, description, desired outcome → `/disputes/{id}` with status in plain words, timeline with ParkBro, photo upload, decision and refund. Hosts see customer trust signals on requests and bookings. Admin dispute screens are Phase 20.

## 16i. As built (Phase 20)
- Admin console (desktop-first, works on mobile): sidebar; Dashboard with queue counts (dash = no permission) and search; list screens with filters and Previous/Next paging; detail screens for users (suspend/reinstate), bookings (history, payments, platform cancel), listings (photos with duplicate/capture flags, approve/reject/suspend/reinstate), disputes (timeline, photos, evidence pack, request info/escalate/resolve with outcome and partial refund); payments (ledger balance check, reconciliation resolve, payments, refunds), payouts (verify accounts, record UTR or failure), reviews (remove), fraud indicators, configuration, audit log. Every action asks for a reason inline.

## 16j. As built (Phase 21)
Admin console **Analytics** page: a period picker (7/30/90/365 days); liquidity cards (searches, zero-result rate, search → booking, booking success, utilisation) with daily SVG trend bars; marketplace, supply (by type) and demand cards; and a liquidity-by-area table (≈1 km cells, most zero-result searches first, type filter; ≥ 50 % zero-result highlighted). Undefined ratios show "—". Loading, error with Retry, and empty states throughout.

## 16k. As built (Phase 22)
Search page: a "Describe what you need" box above the filters ("We fill in the search for you. Don't include phone numbers or other personal details."). Submitting fills in the form, shows "We understood:" chips plus notes (unknown place, unsupported asks), runs the regular search (after device location for "near me"), and offers a Yes/No "Did we get it right?" link. Filters gained a max price field and AC/DC choice for charging. Admin Analytics shows an AI usage table.

## 17. Open UX questions

| ID | Question | Default |
|---|---|---|
| UX-1 | Pilot languages | English + Hindi + the pilot city's language (Kannada for Bengaluru) |
| UX-2 | Product name and brand for copy | Placeholder "[brand]" until decided |
| UX-3 | Offline caching of access credentials: acceptable from a security standpoint? | **Resolved in Phase 4:** allowed, bounded ([trust-and-safety.md §10.2](trust-and-safety.md#102-offline-cache-ux-3-decision-allowed-bounded)) |
| UX-4 | Allow "Extend booking" in the pilot? | No. Show it as future. (It needs an availability re-check plus a payment.) |
