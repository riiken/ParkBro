# Differentiation Strategy

Phase 1 output. Builds on [competitive-analysis.md](competitive-analysis.md) and [market-gaps.md](market-gaps.md). Recommendations here are **proposals for product-owner confirmation**. They don't change requirements in CLAUDE.md.

---

## 1. Positioning

> **Guaranteed private parking, and parking with charging, near where you live and work. Every booking is verified, protected and backed by a promise: you'll get in, or we'll make it right.**

We don't compete on breadth (Park+), hardware (Bolt.Earth, CPOs) or public lots. We compete on **reliability and trust in private infrastructure**, starting with recurring use.

---

## 2. The four questions

### Q1: Why would customers use this platform?
1. **Certainty.** A spot that's actually free when they arrive. Street parking is becoming paid and unguaranteed (Bengaluru Parking Policy 2.0), and private spots are invisible today.
2. **Recourse.** A defined promise when access fails: immediate refund or rebooking, with support escalation. Competitors' customers complain about being turned away without a refund.
3. **Protected monthly arrangements.** Recurring payment, a notice period, registered vehicle access and dispute handling, instead of an informal cash deal that can end any day.
4. **For EV owners blocked by their society:** a reliable nearby AC charge with parking included, overnight or during work hours.

### Q2: Why would hosts list their assets?
1. **Meaningful income through monthly bookings.** ₹2,500–₹15,000/month in Bengaluru and Mumbai, versus negligible hourly earnings (UK research: hosting wasn't "worth a couple of pounds" ad hoc).
2. **Low effort.** No negotiating, no chasing payment, no coordinating with the guard. The platform handles payments, access setup and reminders.
3. **Protection.** Verified customers, clear rules, evidence at check-in, defined damage and dispute handling, guaranteed payment for confirmed bookings, and later an insurance partner. This mirrors Neighbor's host guarantee, which is the top concern in host research.
4. **Control and privacy.** Approve who can book (vehicle type, verified customers only), block time instantly, exact address hidden until booking, contact masking.
5. **Low visible take.** A small host commission. Platform revenue comes mostly from a customer service fee, the international pattern (JustPark 3%, YourParkingSpace 3% + 20% customer uplift).

### Q3: Why would apartment / society owners participate?
1. **Control instead of a ban.** Today a society can only tolerate informal renting or ban it. We offer **governed participation**: approved hosts only, caps on outsider vehicles, allowed hours, vehicle registration, and an exit or suspension switch.
2. **Visibility and security.** The guard sees exactly which vehicle is expected, when, and for which slot. Every entry is logged. That's better than today's informal arrangements.
3. **Revenue to the society fund.** A revenue share on bookings in the property (maintenance or amenity fund). This makes the committee a stakeholder, not a blocker.
4. **Works with existing tools.** We fit into the society's existing visitor-management flow (MyGate, NoBrokerHood, ADDA) or a simple SMS or WhatsApp lookup. We don't ask the guard to adopt another app.
5. **Resolving EV charger conflicts (later):** a managed shared-charger model for the society aligned with the MoP 2024 guidelines (separate metered connection for community charging). This is a potential wedge, but it depends on legal review (R-26).

### Q4: What could become the moat?
In order of defensibility:
1. **Hyperlocal supply density and society partnerships.** Signed societies and commercial properties in a neighbourhood are slow to replicate. A marketplace with the only reliable supply in a micro-market wins that micro-market.
2. **Recurring relationships.** Monthly customers and hosts have high switching costs once access (vehicle registered with the gate) and payment are set up.
3. **Trust and reliability data.** Per-host and per-asset reliability (access success, cancellations, disputes), verified listings and customer trust history. This compounds with every booking and can't be copied.
4. **Access integrations.** Integrations with society visitor systems and gate hardware (later smart chargers) turn a listing into a working, low-touch access point.
5. **Brand promise.** "You'll get in, or we make it right", once earned through operational reliability.

Not moats: app features, AI, map UI. These are easy to copy.

---

## 3. Recommended pilot wedge (proposal)

| Dimension | Recommendation | Rationale |
|---|---|---|
| Lead product | **Monthly / recurring parking** (4W) | Strongest economics and retention (G2, A3). One access setup serves many days. |
| Secondary | Daily and hourly parking from the same supply | Uses spare inventory; tests demand clusters |
| EV | **Parking + AC charging** bookings from independent-house, commercial and small-business hosts first | Avoids residential-resale and society risk (R-26); fills G4 and G5 |
| Supply order | 1) commercial and off-hours lots, independent houses; 2) partner societies (governed); 3) individual apartment hosts **only with society consent** | Lowest permission friction first (A4, A5) |
| Access | Vehicle-number registration + booking code; guard lookup by SMS, WhatsApp or simple web; existing society visitor app where present | A7 refined |
| Geography | One city, 2–3 dense demand clusters (office or tech parks, metro stations, high-density residential with a parking deficit) | Liquidity depends on density (R-01) |
| Out of pilot | 2W/3W, ad-hoc home charger sharing, per-kWh pricing, own hardware | See market-gaps "not chasing" |

**City:** Bengaluru is a strong candidate (paid street-parking policy, IT clusters, research shows price anchors). Mumbai has higher prices but stricter society governance. **The product owner decides.**

---

## 4. Implications for upcoming phases

These are inputs, not implementations.
- **Phase 2 (domain):**
  - Asset **capacity** (N interchangeable slots) as well as single named slots.
  - **Recurring and monthly booking** as a first-class booking shape, with renewal and notice.
  - **Property-level policy** (society rules: caps, hours, approved hosts) that constrains assets.
  - **Booking promise / recourse** as an explicit state path (access failed → rebooked or refunded).
  - EV booking = parking + charger.
- **Phase 3 (UX):** the arrival flow and the "I can't get in" recovery are core screens. The society admin view needs expected vehicles and an access log.
- **Phase 4 (trust):** host attestation of the right to rent; society consent for apartment hosts; evidence capture at check-in; host protection terms.
- **Phase 15/16 (finance):** customer service fee plus low host commission; society revenue share as a separate ledger line; guaranteed host payment for confirmed monthly bookings.
- **Phase 17 (access):** adapters for vehicle-number lookup and booking code first. Society visitor-app integration is an adapter, not core.

---

## 5. Competitive risks to watch

- **Park+ enters peer-to-peer or society parking** using its 3,000+ gate installs and FASTag base. Response: speed in the pilot micro-markets, society partnerships and the reliability promise.
- **MyGate / NoBrokerHood add a parking marketplace** for their societies. Response: we serve cross-society and commercial supply and demand from outsiders, which their resident-only base doesn't. A partnership is also possible.
- **Bolt.Earth adds parking bundles.** Response: we're parking-first, and EV is an asset type on the same engine.
- **Global consolidation** (Uber–SpotHero, closed April 2026) signals that parking is valued as part of mobility super-apps. A future partnership or exit path exists, but it isn't a near-term threat in India.
