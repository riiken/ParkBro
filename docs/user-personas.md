# User Personas

Phase 0 output. These are hypothesis personas, to be validated through Phase 1 research and pilot interviews. Each persona lists the need, pains, what they must trust, and implications for the product. IDs (C1, H1 and so on) are referenced in [core-user-journeys.md](core-user-journeys.md) and [risk-register.md](risk-register.md).

---

## Customers / drivers

### C1: Daily office commuter
- **Need:** a guaranteed spot near the office or a metro station on weekdays, 9:00–19:00.
- **Pains:** circling for parking, paid lots full by 10:00, towing and fines from street parking.
- **Trusts the platform for:** the spot actually being free every day, easy entry, and no surprise charges.
- **Implications:** recurring weekday or monthly bookings, fast repeat booking, reliable access instructions. Highest lifetime value if it's reliable.

### C2: Resident without home parking (monthly)
- **Need:** a long-term overnight or monthly spot near home for a second car, or because the building has no parking.
- **Pains:** street parking leads to damage, theft and disputes with neighbours. Informal arrangements break down.
- **Trusts the platform for:** continuity (the host won't cancel abruptly), safety of the vehicle overnight, and a clear notice period.
- **Implications:** monthly contracts with a notice period, recurring payment, stable access (vehicle number registered with the guard). This is likely the strongest liquidity anchor.

### C3: Occasional visitor
- **Need:** a spot for a few hours: hospital visit, shopping, a wedding or event, a client meeting.
- **Pains:** no parking at the destination, unfamiliar area, urgency.
- **Trusts the platform for:** the spot existing right now, simple payment, and directions to the exact entrance after booking.
- **Implications:** fast search by destination, instant booking, minimal sign-up friction, clear refund if access fails. Lowest tolerance for friction.

### C4: EV owner without home charging
- **Need:** regular, predictable charging near home or work. Usually AC charging overnight or during office hours.
- **Pains:** the apartment won't allow a charger, public chargers are far, broken or occupied.
- **Trusts the platform for:** the charger working, a compatible connector, a known price, and being allowed to stay parked while charging.
- **Implications:** EV booking = parking slot + charger for a time window. Connector compatibility filter. Recurring bookings. Charger-failure dispute path.

### C5: EV intercity or long-distance driver
- **Need:** a top-up charge along a route or at a destination.
- **Pains:** range anxiety, unreliable public DC chargers.
- **Implications:** needs DC or fast charging, which home hosts rarely have. Lower priority for a residential-first pilot. It may matter later for business hosts (hotels, dhabas, cafes).

### C6: Long-stay traveller
- **Need:** multi-day parking near an airport or railway station.
- **Pains:** expensive official lots.
- **Implications:** daily or multi-day booking. Pick-up and drop-off rules. Higher trust bar for unattended multi-day parking.

### C7 (open question): 2W/3W riders, including EV delivery fleets
- Large Indian segment. Possibly B2B (fleet operators). Whether it's in scope is decided before Phase 2. See [product-discovery.md §11](product-discovery.md#11-open-questions-need-a-product-owner-decision).

---

## Hosts / asset owners

### H1: Apartment owner with an idle allotted slot
- **Motivation:** extra income from a slot that's idle during the day, or a second slot that's permanently free.
- **Fears:** the society objecting, strangers in the building, the slot not being free when they return, overstay.
- **Needs:** easy blocking of personal time, buffer between bookings, control over who books (vehicle type, verified customers only), guard notification handled by the platform.
- **Constraint:** may need society permission. See S1.

### H2: Independent-house owner
- **Motivation:** income from a driveway or gate-front parking. Fewer permission hurdles than H1.
- **Fears:** someone entering the property and family safety.
- **Needs:** precise rules ("park outside the gate only"), identity-verified customers, contact masking.

### H3: Small commercial owner (shop, clinic, small office)
- **Motivation:** monetising the lot after hours or on weekends.
- **Needs:** schedule-based availability (for example 19:00–09:00 and Sundays) and bulk slots (multiple identical spots).
- **Implication:** an asset may represent **N interchangeable slots** (capacity), not only a single named slot. Resolved in Phase 2: unit-based inventory (D-012, [domain-model.md](domain-model.md)).

### H4: Facility manager / commercial building operator
- **Motivation:** utilisation of underused capacity, often on behalf of an owner.
- **Needs:** multi-asset management, staff accounts, reports, invoices, payouts to a business account. Overlaps with the property-admin role.

### H5: Home EV charger owner
- **Motivation:** recovering charger cost and earning from idle charger time.
- **Fears:** damage to the charger or cable, electricity cost exceeding earnings, DISCOM or tariff trouble.
- **Needs:** pricing that covers electricity (per hour or session until metering exists), connector and power specification, usage rules.

### H6: Small business with a charger (cafe, hotel, restaurant)
- **Motivation:** footfall plus charging revenue.
- **Needs:** business payouts, GST invoicing, possibly a commercial electricity connection already in place. A lower regulatory risk source of EV supply than H5.

---

## Property / society stakeholders

### S1: RWA / society committee
- **Role:** grants or denies permission for outsiders to use slots, and sets society rules.
- **Concerns:** security, liability, resident complaints, fairness among residents.
- **Wants:** control (approve hosts, cap visitor count, set allowed hours), visibility (who's inside, for which booking), and possibly a revenue share into the maintenance fund.
- **Implication:** a future Property Admin role (CLAUDE.md §5). Treating societies as first-class partners may be the unlock for apartment supply (assumption A4).

### S2: Security guard / gate staff
- **Role:** physically lets customers in or turns them away. **They decide whether the arrival succeeds.**
- **Constraints:** often uses a basic phone, may not speak English, high turnover, works shifts, may already use a visitor-management app.
- **Needs:** a dead-simple way to check that "this vehicle has a valid booking right now" (vehicle number lookup or a 4–6 digit code, possibly by SMS or WhatsApp), and no burden of judgement.
- **Implication:** the access design (Phase 17) must work without the guard installing an app.

### S3: Facility / estate manager
- Operates the building on behalf of the society or owner. May be the property admin user in practice.

### S4: Commercial property owner
- Similar to H3 or H4 at larger scale. Possible B2B contract instead of per-booking listing.

---

## Platform administrators

| ID | Role | Core responsibilities |
|---|---|---|
| A1 | Operations / support | Booking issues, access failures, rebooking, customer and host communication |
| A2 | Trust & safety | Listing and host verification, fraud flags, suspensions, high-risk disputes (human-resolved, CLAUDE.md §18) |
| A3 | Finance | Payment reconciliation, refunds, payout runs, commission and tax reports |
| A4 | Super-admin | Platform configuration (commission rates, fees, cancellation policies), admin user management |

At pilot scale one person may hold all four roles. Even so, the system should model them as separate permissions so actions stay auditable and least-privilege works later.

---

## External (non-user) stakeholders

- **Payment provider / aggregator:** collection, split settlement, refunds, payouts.
- **DISCOM:** electricity tariffs and rules on resale for EV charging.
- **Municipal authority:** commercial-use and parking regulations.
- **Neighbours:** complaints about strangers or blocked driveways can end supply.
- **Insurers:** potential partners for damage cover.
