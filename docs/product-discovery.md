# Product Discovery

Phase 0 output. Defines what the product is, who it serves, the problems it must solve, and the initial architecture direction. Market and competitor research is deliberately deferred to Phase 1. Statements about the Indian market here are working assumptions until Phase 1 validates them.

Related: [user-personas.md](user-personas.md) · [core-user-journeys.md](core-user-journeys.md) · [business-model.md](business-model.md) · [risk-register.md](risk-register.md) · [decision-log.md](decision-log.md)

---

## 1. Repository audit (2026-10-19)

| Area | Finding |
|---|---|
| Application code | None. Greenfield project. |
| Frontend / Backend | None. |
| Database / Migrations | None. |
| APIs | None. |
| Authentication | None. |
| Integrations | None. |
| Tests | None. |
| Documentation | `CLAUDE.md` (project constitution) and `PHASES.md` (24-phase roadmap: Phase 0 to Phase 23). `docs/` created in this phase. |
| Deployment / CI | None. |
| Configuration / secrets | None. No `.env` and no `.gitignore`. |
| Version control | **`ParkBro/` is not its own git repository.** It sits untracked inside a git repo rooted at `/Users/riiken/Documents`, whose remote is `riiken/whatsapp-booking-assistant`. A commit made from here would land in that unrelated project. A dedicated repository is needed before any code is written. See [decision-log.md](decision-log.md) D-007. |

**Conclusion:** this is a new project. Phase 0 sets the starting architecture direction (section 9). It does not build anything.

---

## 2. Product definition

**One line:** a trusted marketplace where people, residential societies and businesses rent out private parking and EV charging they aren't using. Drivers can find it, book it, pay for it and get in.

**What it is**
- A two-sided marketplace: hosts supply the assets and drivers create the demand. The platform earns a commission.
- One generic asset engine (asset → availability → booking → payment → access → review). Parking and EV charging are the first two asset types.
- A trust product as much as a booking product. Strangers enter private and residential premises.

**What it is not (for now)**
- Not a municipal or on-street parking operator. Not a parking-lot management system (PMS) for operators.
- Not a charge-point operator (CPO). Not an OCPP hardware network. No live charger control is assumed.
- Not a car-services marketplace. Washing, detailing and similar services are future asset types and won't be built.

**Core value exchange**

| Party | Gives | Gets |
|---|---|---|
| Host | Access to an idle slot or charger, availability, rules | Predictable income, control, safety, low effort |
| Customer | Payment, vehicle and identity details, rule compliance | A guaranteed spot or charger near the destination, with no circling or queuing |
| Property / society | Permission, gate cooperation | Revenue share or amenity fund, control over who enters, fewer disputes |
| Platform | Discovery, booking, payments, trust, support | Commission and service fees |

---

## 3. Market context (working assumptions)

- **India first, urban first.** Currency is INR, display time is IST, and UPI is the dominant payment method. Societies, RWAs (resident welfare associations) and security guards are central to access. Phase 1 validates this market.
- Severe parking shortages exist in dense neighbourhoods, near office clusters, metro stations, hospitals, markets and event venues. Many households own more cars than they have allotted slots.
- Allotted apartment slots are often idle during working hours (the owner drives to work) or permanently idle (no car, or a second slot).
- EV adoption is growing faster than public charging in residential areas. Many EV owners in apartments **cannot install a home charger**, and that's a strong demand pocket.
- Two-wheelers (2W) and three-wheelers (3W) are a large share of Indian EVs and of parking demand. Whether they're in scope is an open question (section 11).
- Pilot strategy (from PHASES.md Phase 23): one city, a few neighbourhoods. The marketplace only works with **hyperlocal density**.

---

## 4. Stakeholders

Full detail is in [user-personas.md](user-personas.md).

- **Customers / drivers:** daily commuters, residents who need monthly parking, occasional visitors, EV owners without home charging, long-stay travellers.
- **Hosts:** apartment owners with idle allotted slots, independent-house owners, small commercial owners, facility managers with off-hours capacity, home or small-business charger owners.
- **Property / society stakeholders:** RWA or society committee, facility manager, **security guards and gate staff** (critical to access, often not app users), commercial building owners.
- **Platform admins:** operations and support, trust and safety, finance and payouts, super-admin.
- **External:** payment provider, DISCOM (electricity distribution company), municipal authorities, neighbours, insurers.

---

## 5. Supply-side problems

1. **Permission, not just willingness.** Many apartment owners can't legally or socially rent a slot to outsiders without society approval. Society bylaws may forbid it. Supply from apartments may need society-level onboarding rather than individual hosts.
2. **Host fear:** strangers in the building, damage, the guest overstaying or blocking the host's own car, neighbours complaining.
3. **The host needs the slot back:** the host's own schedule changes (comes home early, a guest arrives). Availability has to be easy to block and must be respected.
4. **Effort:** listing, photos, answering questions, letting the guard know. Supply churns if each booking needs manual work.
5. **Low and uncertain earnings:** a few hundred rupees a month may not justify the hassle. Monthly bookings change that.
6. **Slot ambiguity:** stacked or tandem parking, numbered versus unnumbered slots, and shared basements make "which spot?" non-trivial.
7. **Payout trust:** hosts need to see when and how much they'll be paid, and what the platform deducted.
8. **Tax and compliance confusion:** whether income is taxable, GST thresholds, and tax deducted by the platform.

## 6. Demand-side problems

1. **Uncertainty:** "Will there actually be a spot when I arrive?" This is the core problem. Booking only adds value if the spot is guaranteed.
2. **Discovery:** private spots are invisible today. Customers need search by destination and time, not by listing.
3. **Access friction:** the guard doesn't know about the booking, the gate is closed, the slot is occupied, or the instructions are unclear. **The arrival moment is where trust is won or lost.**
4. **Price clarity:** the total cost up front, including fees and overstay rules.
5. **Vehicle fit:** SUV versus hatchback, ceiling height, ramp angle, 2W versus 4W.
6. **Recourse:** what happens if the spot is unavailable on arrival (refund, rebooking, compensation).
7. **Recurring need:** commuters want monthly or weekday-recurring parking, not 22 separate bookings.

## 7. Trust, safety and privacy problems

**Trust**
- Fake or inaccurate listings: the photo shows a covered slot but it's an open lane, or the host doesn't control the slot at all.
- Hosts with no right to rent the slot (tenants subletting, or the society prohibits it).
- Reviews can be gamed. Ratings alone are not a safety mechanism (CLAUDE.md §19).
- Off-platform leakage: host and customer meet once, then transact directly in cash.

**Safety**
- A stranger enters a residential complex. This raises society security and child-safety concerns.
- Customer personal safety: dark basements, isolated lots, late-night retrieval.
- Vehicle damage or theft while parked. Property damage by the customer. Electrical or fire risk from charging, including damaged cables and improper sockets.
- Who is liable and is there insurance? This is unresolved and is an open question.

**Privacy**
- Exact residential addresses and flat numbers must not be exposed before booking. Approximate location is shown before booking, and exact access details only after a confirmed booking (CLAUDE.md §11).
- Host phone numbers should not be exposed by default. Use relay or masked contact where possible.
- Vehicle registration numbers, identity documents and location history are personal data under India's DPDP Act 2023 and its Rules (applicability and timelines to be verified with counsel in Phase 4).
- Access credentials (OTP, QR) must be scoped to one booking window and must not be reusable.

## 8. Payment, booking and EV-charging problems

**Payments**
- Marketplace funds flow: a regulated payment aggregator must collect and split funds. The platform should not hold customer money informally.
- Customer payment, platform commission, taxes, host payable and payout are separate concepts and need a ledger (CLAUDE.md §8, §16).
- Payment success comes only from provider webhooks with signature verification, never from the client (CLAUDE.md §15).
- Refunds for cancellations, host no-shows and disputes. Partial refunds for early exit, and extra charges for overstay.
- Charging after the fact (overstay, kWh-based) is hard with UPI. It needs a pre-authorised buffer or upfront pricing.
- Tax obligations (GST on commission and services, e-commerce-operator TCS/TDS) need confirmation from a CA before Phase 15.

**Booking**
- Double booking and race conditions: two customers book the same slot at the same moment (CLAUDE.md §13–14).
- The host's own usage conflicts with bookings. The host must be able to block time, and must not be able to cancel confirmed bookings silently.
- Overstay leads to a conflict with the next booking. Buffer times between bookings are likely needed.
- No-shows by the customer. No-shows or unavailability by the host.
- Time zones: store UTC and display IST. Asset-local time zones keep it future-proof.
- Booking granularity: hourly, daily, overnight, monthly, recurring. These are different products with different access patterns. Monthly bookings are likely the liquidity anchor (hypothesis H2 in [business-model.md](business-model.md)).

**EV charging**
- **Metering:** without hardware, kWh delivered is unverifiable. Initial pricing should be per session or per hour. Per-kWh pricing waits for metered or smart chargers.
- **Charging speed:** home chargers are mostly AC 3.3–7.4 kW, and some are 15 A sockets. A full charge takes hours, so an EV booking is effectively **parking plus a charger for a time window**.
- **Compatibility:** connector types include Type 2 AC, CCS2 DC, legacy Bharat AC-001/DC-001, 15 A domestic sockets (2W/3W), and some GB/T. The vehicle-to-charger match must be explicit.
- **Electricity regulation:** a host reselling household electricity may conflict with DISCOM tariff categories. Public-charging guidelines may also require separate metering. **This is a legal and regulatory open question** that could limit residential EV supply.
- **Charger failure:** the charger doesn't work on arrival, or trips mid-session. This needs a dispute path and an abstraction for future smart-charger status.
- **Safety:** cable condition, earthing and fire risk.

---

## 9. Initial architecture direction

These are directions, not final decisions. Phase 5 (architecture) and Phase 6 (database) make the final calls, recorded in [decision-log.md](decision-log.md).

- **Modular monolith** with the module boundaries in CLAUDE.md §24. A single deployable keeps the build simple, and modules can be split later if evidence supports it.
- **PostgreSQL** as the system of record. Strong candidates to evaluate in Phase 6:
  - **PostGIS** for radius and nearest-neighbour discovery.
  - **Range types with `btree_gist` exclusion constraints** (`EXCLUDE USING gist (asset_id WITH =, period WITH &&)`) as a database-level guarantee against double booking, in addition to application checks.
- **Generic asset model:** a core `asset` with an `asset_type`, plus type-specific detail records (parking details, charger details). Booking, availability, pricing, payments and reviews depend only on the generic asset.
- **Provider abstractions** for payments, notifications, maps, access mechanisms and future charger integrations. No vendor lock-in inside domain logic.
- **Mobile-first client.** Most usage happens on a phone, in or near a car. Whether that means a responsive web app / PWA first or a native app is decided in Phase 3 and Phase 5. A web-first approach lowers pilot cost.
- **Language and stack:** decided in Phase 5. The default leaning is TypeScript end to end for one language across client and server, with strict typing and an ecosystem that fits payments and maps.
- **AI** comes last (Phase 22). It is never a source of truth for availability, price, booking, payment or access.
- **Not planned:** microservices, Kubernetes, event streaming, vector databases (CLAUDE.md §31).

---

## 10. Key assumptions

Phase 1 validation of each assumption is in [market-gaps.md](market-gaps.md#validation-of-phase-0-assumptions).

| ID | Assumption | Validate in |
|---|---|---|
| A1 | India, urban, one pilot city first | Phase 1 |
| A2 | UPI-first payments through a regulated payment aggregator with split or route settlement | Phases 1, 15 |
| A3 | Monthly and recurring parking drive more liquidity than ad-hoc hourly parking | Phase 1, pilot |
| A4 | Societies, not individual flat owners, are the realistic unit of apartment supply | Phase 1 |
| A5 | Commercial and off-hours property supply has less access and permission friction than residential | Phase 1 |
| A6 | No charger hardware integration at launch. EV pricing is per session or per hour. | Phase 14 |
| A7 | Security guards can be integrated through a low-tech verification path (booking code or vehicle number), without needing to install an app | Phases 3, 17 |
| A8 | Customers accept approximate location before booking if the distance and walk time are clear | Phase 3 |

## 11. Open questions (need a product-owner decision)

1. **Pilot city and neighbourhoods.** Which city? Which demand clusters (office parks, metro stations, hospitals)?
2. **Two-wheelers.** Are 2W/3W parking and charging in scope for the pilot? This affects vehicle model, slot model, connector list and pricing.
3. **Supply strategy.** Individual hosts, society-level onboarding, commercial properties, or a mix? Which comes first?
4. **Booking types for the pilot.** Monthly only, hourly only, or both?
5. **Liability and insurance.** Who is responsible for vehicle or property damage? Is there a host guarantee or a partner insurer?
6. **Legal and regulatory review.** Society bylaws and subletting, DISCOM rules on EV charging resale, municipal commercial-use rules, payment aggregator model, GST/TCS/TDS, DPDP compliance. Who is the legal and tax advisor?
7. **Brand and product name.** "ParkBro" is the folder name. Is it the product name? It also matters because the platform targets EV charging, not just parking.
8. **Client platform.** PWA/web first versus native app first.
9. **Repository.** Create a dedicated git repository for `ParkBro/` (see section 1)?
10. **Team and budget.** Solo or team? This affects how much operational tooling (admin, support) the pilot needs on day one.
