# Business Model

Phase 0 output. All figures below are **illustrative hypotheses** used to reason about structure, not validated market data. Phase 1 replaces them with researched benchmarks, and the pilot replaces those with real data. Tax and regulatory points need confirmation from a CA and legal counsel before Phase 15.

---

## 1. How the platform makes money

| Stream | Description | Pilot? |
|---|---|---|
| Host commission | % of booking value deducted from the host payout | Yes |
| Customer service fee | Small fee added on top of booking value, shown up front | Maybe. Test against conversion. |
| Monthly / recurring bookings | Same commission model on recurring payments, the highest-value stream | Yes (hypothesis H2) |
| Society / property partnerships | Revenue share with the society, possibly a SaaS fee for visitor and parking management | Later |
| B2B | Corporate employee parking, EV fleet charging contracts | Later |
| Overstay / cancellation fees | Policy-driven. Mostly passed to the host, possibly with a platform share. | Policy decided in Phase 12 |

Explicitly **not** planned: advertising, selling user data, or lead-gen fees to hosts.

---

## 2. Money flow (financial concepts kept separate, CLAUDE.md §8 and §16)

```
CUSTOMER PAYMENT (total charged)
 = Booking value (host price × duration)
 + Customer service fee (if any)
 + Taxes on platform fee (as applicable)
        │
        ▼
 PAYMENT PROVIDER (collects; deducts gateway fee from the platform)
        │
        ▼
 PLATFORM LEDGER
 ├── Platform revenue = host commission + customer service fee
 ├── Taxes payable     (GST on platform fees; TCS/TDS withheld from host where applicable)
 └── Host payable      = booking value − host commission − withheld taxes
            │
            ▼
        PAYOUT (scheduled; after completion + dispute window)
```

Each of these is a separate ledger concept with its own record and state: customer payment, refund, platform commission, fee, tax, host payable, payout. A refund or dispute after payout creates a host **receivable / negative balance**, which is recovered from future payouts.

---

## 3. Pricing approach

- **Hosts set prices**, with platform guidance (suggested range from nearby listings, later demand data). Dynamic pricing is a later AI and analytics feature (Phase 22), and only as a recommendation.
- **Pricing units differ by product:**
  - Parking: hourly, daily, overnight (fixed window), monthly.
  - EV charging: per session or per hour at first. **Per kWh only once metering exists** (no hardware is assumed).
- **The customer always sees the all-in total before paying.** No surprise fees.
- Pricing is computed by a deterministic pricing module, never by a client or an LLM.

---

## 3a. Phase 1 update: market pricing pattern

Research ([competitive-analysis.md §3](competitive-analysis.md#3-patterns-across-the-market)) shows that peer-to-peer parking leaders keep the **host-visible cut low** (JustPark 3%, YourParkingSpace 3%, Neighbor 4.9% + $0.30) and earn mainly through a **customer service fee** (YourParkingSpace +20%). The proposed structure is now a low host commission plus a customer service fee (D-010). The 15% host commission below is kept only as an illustration of *total* take rate.

Indian monthly price anchors (asking prices): Bengaluru ₹2,500–₹4,500/month, Mumbai ₹5,000–₹15,000/month.

## 4. Illustrative unit economics (hypothetical numbers)

Assumptions: host commission 15%, no customer fee, gateway cost ~2% of the amount collected (UPI costs may be lower), GST not shown.

| Booking | Value | Platform commission | Gateway cost | Platform contribution | Host net |
|---|---|---|---|---|---|
| Hourly: 4 h × ₹40 | ₹160 | ₹24 | ~₹3 | ~₹21 | ₹136 |
| EV session: 4 h × ₹100 | ₹400 | ₹60 | ~₹8 | ~₹52 | ₹340 |
| Monthly parking | ₹3,000 | ₹450 | ~₹60 | ~₹390 | ₹2,550 |

**Takeaways (to validate):**
- One monthly booking ≈ the contribution of ~19 hourly bookings, with **one** onboarding and access setup instead of 19. Support and access-failure cost per booking is the hidden variable.
- Hourly bookings are viable only if access is near-zero-touch. One support call can wipe out the margin.
- Customer acquisition cost must be recovered through repeat usage. Retention matters more than first bookings.

---

## 5. Key business hypotheses

| ID | Hypothesis | How to test |
|---|---|---|
| H1 | Drivers in dense clusters will pay a premium for a *guaranteed* spot | Pilot conversion and repeat rate |
| H2 | Monthly / recurring parking is the liquidity and revenue anchor | Booking mix and revenue share in the pilot |
| H3 | A ~10–20% total take rate is acceptable to hosts | Host onboarding conversion and churn |
| H4 | Society partnerships unlock far more supply than individual apartment hosts | Supply acquired per sales effort |
| H5 | EV owners without home charging will book recurring residential AC charging | EV booking repeat rate |
| H6 | Access can be handled with low-tech methods (code or vehicle number) at acceptable failure rates | Access-failure rate per booking |

---

## 6. Cost structure (expected)

- Payment gateway fees, refunds and chargebacks.
- Customer support and operations: likely the largest variable cost early on.
- Supply acquisition: field sales to societies and businesses, host onboarding.
- Verification costs (OTP, SMS, any KYC). Use risk-based verification so this stays proportional (CLAUDE.md §10).
- Notifications: SMS and WhatsApp per-message costs.
- Infrastructure: modest at pilot scale.
- Maps / geocoding API costs.
- Insurance or a host guarantee fund (if chosen).

---

## 7. Regulatory and tax items to resolve (not legal advice)

These need confirmation from a qualified CA or lawyer before money moves (Phase 15):
- **Payment aggregator model:** collection and split settlement via a licensed aggregator (route or split payments). The platform should not hold funds outside that structure.
- **GST:** on platform commission and fees, on the underlying parking or charging service, host registration thresholds, and e-commerce-operator obligations.
- **TCS (GST) and TDS (Income Tax, e-commerce operators):** withholding obligations on host payouts. Rates and thresholds have changed recently, so verify the current ones.
- **EV charging:** whether a residential host can charge for electricity under their DISCOM tariff, and the metering requirements.
- **Society bylaws / subletting:** platform terms must require hosts to confirm they have the right to rent the slot.
- **DPDP Act 2023 and Rules:** consent, purpose limitation, retention and breach obligations for personal data (vehicle numbers, location, identity).

---

## 8. Marketplace health metrics (CLAUDE.md §9)

Primary question: *can a customer reliably find a suitable asset nearby when they need it?*

- **Liquidity:** search-to-booking conversion, searches with zero results (by area and time), fill rate.
- **Reliability:** booking success rate, access-failure rate, host cancellation rate, no-show rate.
- **Supply:** active assets per km² in pilot zones, utilisation per asset, host retention.
- **Demand:** repeat booking rate, customer retention, monthly bookings share.
- **Economics:** GMV, net revenue, contribution per booking, support contacts per booking.

Detailed definitions come in Phase 21 (`analytics.md`).
