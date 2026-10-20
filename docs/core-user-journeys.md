# Core User Journeys

Phase 0 output. These journeys describe behaviour and system responsibilities. Screens and navigation are designed in Phase 3 (`ux-architecture.md`). State names here are illustrative; explicit state machines are defined in Phase 2 (`domain-model.md`).

Each journey covers: **steps**, **what the system must guarantee**, and **failure paths**. Persona IDs come from [user-personas.md](user-personas.md).

---

## Customer journeys

### CJ-1: Find and book a short-term parking spot (C1, C3)
1. Customer enters a destination, or uses current location, plus a time window and vehicle.
2. System returns available assets nearby. Each shows approximate location, distance or walk time, total price, key attributes (covered, CCTV, vehicle fit) and rating.
3. Customer views a listing: photos, rules, approximate map area, cancellation policy, total price breakdown.
4. Customer books. The system **re-checks availability inside the commit transaction** and places a time-limited hold.
5. Customer pays. **The booking becomes confirmed only on a verified payment-provider webhook**, never on the client callback.
6. Confirmation: exact address, entrance, slot identifier, access method and host contact (masked) are revealed **only now**.

**Guarantees:** no double booking, price shown = price charged, exact location hidden until confirmed.
**Failure paths:**
- Availability changes between search and booking. Show a clear message and alternatives.
- Payment fails or is abandoned. The hold expires and the slot is released.
- Webhook is delayed. Show "confirming payment" and reconcile. Never leave a paid booking unconfirmed or an unpaid one confirmed.
- Duplicate submit. An idempotency key prevents a second booking or charge.

### CJ-2: Monthly / recurring parking (C2, C1)
1. Search with a start date, duration (monthly) or recurrence pattern (weekdays 9:00–19:00).
2. The system checks availability across the **whole** period, not just day one.
3. Book and pay for the first period. The renewal and notice-period rules are shown up front.
4. Access is set up once, for example by registering the vehicle number with the gate.
5. Renewal: payment collected before the next period (mandate or reminder). Either side ends it per the notice policy.

**Guarantees:** the host cannot silently double-allocate a monthly slot. Termination rules are explicit and symmetric.
**Failure paths:** renewal payment fails (grace period, then release). The host wants the slot back (notice period, platform-assisted rebooking). The host sells or moves out.

### CJ-3: Book EV charging (C4, C5)
1. Customer filters by connector compatible with their vehicle, AC/DC, minimum power and time window.
2. Listing shows charger spec, pricing basis (per session or hour initially), parking included, rules (for example "unplug and move at end time").
3. Book and pay as in CJ-1. The booking covers **parking slot + charger** for the window.
4. Arrive, access, plug in. Charging start and end are self-reported at first. Smart-charger integration is future work.
5. Complete. Optionally report the outcome (charged fine, charger faulty).

**Guarantees:** connector compatibility is checked deterministically before booking. Price basis is explicit.
**Failure paths:** charger dead or tripping (fast dispute and refund path), slot ICE-d (blocked by a non-EV car), vehicle incompatible despite filter (data quality issue).

### CJ-4: Arrival and access (all customers): highest-risk moment
1. Before start: reminder with navigation link, access instructions and booking code.
2. At gate: customer shows code, QR or vehicle number. The guard or host verifies **a valid booking for this time window** (Phase 17).
3. Customer parks in the identified slot.
4. Access events are logged (verified, entered, exited where available).

**Failure paths and what the system must offer:**
- Guard refuses entry. In-app "I can't get in" leads to a host or support escalation with a timer, then automatic refund or rebooking.
- Slot occupied (host's car or another car). Same escalation, plus evidence capture (photo, timestamp).
- Customer can't find the entrance. Clearer post-booking directions and a photo of the entrance.
- Customer arrives early or late. The access window policy is explicit (grace periods).

### CJ-5: Cancel or modify
1. Customer cancels. The refund is calculated **deterministically** from the policy and the time to start.
2. Reschedule (where supported): treated as an availability check plus a price-difference settlement in one transaction.

**Guarantees:** refund amount is shown before confirming. Cancellation and refund are idempotent.

### CJ-6: End of booking, overstay and early exit
1. Booking ends. Reminder before the end time.
2. Overstay. Policy-driven extra charge or fixed penalty. The next customer's booking is protected by buffer time and escalation.
3. Early exit. Normally no refund unless the policy says otherwise.

**Open question:** how overstay is detected and charged without hardware (self-report, host report, or guard exit log).

### CJ-7: Dispute (all)
1. Customer or host opens a dispute tied to a booking, with a reason and evidence (photos, notes).
2. System attaches booking, access, payment and communication logs automatically.
3. Low-risk cases (for example host-confirmed unavailability) may resolve by rule. **High-risk cases (damage, safety, misconduct) go to a human (A2).**
4. Outcome leads to a refund, adjustment, penalty or suspension, all audit-logged.

### CJ-8: Review
- After completion, both sides review (customer → host and listing, host → customer). Reviews are tied to a completed booking only. Ratings feed trust signals but are not the only safety control.

---

## Host journeys

### HJ-1: Onboard and list an asset (H1–H6)
1. Register and verify phone. More verification is risk-based (Phase 4).
2. Create or select a property (address, private and never shown publicly, plus an approximate public area).
3. Create an asset: type (parking or EV charger), attributes, photos, rules, access instructions (private until booking).
4. Set availability (recurring schedule plus exceptions) and price.
5. Submit for publishing. Depending on risk, the listing may need verification (photos, proof of right to rent, society approval).
6. Listing goes live.

**Failure paths:** verification rejected (actionable reason), duplicate or fake listing detected, incomplete listing saved as a draft.

### HJ-2: Manage availability and pricing
- Block personal time instantly. **Blocking cannot override confirmed bookings.** The host must cancel explicitly, with consequences.
- Edit price. This applies to future bookings only. Existing bookings keep their agreed price.

### HJ-3: Receive and manage bookings
1. Notified of a new confirmed booking (instant booking by default; whether request-to-book is supported is decided in Phase 2).
2. Sees booking details with **only the customer data needed**: name, vehicle number and type, time window.
3. Handles arrival issues (confirm access, report a no-show).

### HJ-4: Host cancellation
- Allowed but penalised (fees, ranking impact, suspension on repeat). The customer gets a full refund plus help rebooking. This protects demand-side trust.

### HJ-5: Earnings and payout
1. Sees per booking: gross, platform commission, fees and taxes, net payable.
2. Earnings move from pending (booking not yet complete or within the dispute window) to payable to paid out.
3. Adds payout details (bank account or UPI) with verification. Payout runs on a schedule. Failures are surfaced.

---

## Property / society journeys

### PJ-1: Society onboarding (S1, S3)
1. Society agrees terms (allowed hosts, hours, visitor caps, revenue share).
2. Platform links hosts in that property and applies society rules to their assets.
3. Society sees who is expected (bookings for today) and access logs, without customer PII beyond what security needs.

### PJ-2: Guard verification (S2)
1. Vehicle arrives. The guard checks the vehicle number or code using a minimal channel (SMS or WhatsApp lookup, a simple web page, or a printed daily list as fallback).
2. System answers yes or no: valid for this property and this time window, and which slot.
3. Entry is logged.

---

## Platform admin journeys

### AJ-1: Listing and host verification (A2)
Queue of new or changed listings. Review photos, documents and flags. Approve or reject with a reason. All actions are audit-logged.

### AJ-2: Support and dispute resolution (A1, A2)
Search a booking. See the full timeline (booking, payment, access, messages). Take an action (refund, rebook, penalise). High-risk outcomes need a human decision.

### AJ-3: Finance reconciliation and payouts (A3)
Match provider settlements against internal ledger entries. Investigate mismatches. Approve and monitor payout runs. Handle failed payouts.

---

## Cross-journey invariants

1. Availability, price, booking state, payment state and access authorization come **only** from deterministic backend state (CLAUDE.md §13, §15, §22).
2. Exact location and access instructions are revealed only to an authorised party with a confirmed booking (CLAUDE.md §11).
3. Every money-moving action is idempotent and ledgered.
4. Every journey has a defined failure path and a human escalation route for safety-critical failures.
