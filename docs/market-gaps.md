# Market Gaps

Phase 1 output. Each gap is grounded in [competitive-analysis.md](competitive-analysis.md). The confidence rating reflects the strength of the evidence, not the size of the opportunity.

---

## G1: No trusted, verified private-parking marketplace with guaranteed access and recourse in India
- **Evidence:** Park+ books operator and government lots, not private residential or commercial supply. Indian peer-to-peer apps (ParkingMudde, ParkForRent, ParkSpot) exist but show little independent evidence of verification, access guarantees or scale. Customers complain about being turned away from booked parking without a refund.
- **Gap:** "Book → you will get in → or you'll be refunded or rebooked immediately" does not exist as a dependable promise.
- **Confidence:** Medium. The incumbents' gaps are clear, but small apps' traction is unverified.

## G2: Monthly / long-term private parking is an informal, unprotected market
- **Evidence:** monthly asking prices of ₹2,500–4,500 in Bengaluru and ₹5,000–15,000 in Mumbai, listed on classifieds and listing sites without payment protection, contracts or dispute handling. International leaders earn mainly on monthly and event parking. Bengaluru is moving toward paid on-street residential parking with no guaranteed spot.
- **Gap:** a protected monthly arrangement covering recurring payment, notice periods, a guaranteed spot, registered vehicle access and dispute handling.
- **Confidence:** Medium–high. This supports hypothesis H2 (monthly is the anchor).

## G3: Society-level access is the unsolved chokepoint
- **Evidence:** gates are controlled by guards using MyGate, NoBrokerHood or ADDA, or by RFID/ANPR barriers (Park+, ParkZap). Society bye-laws (for example Maharashtra 78–84) give committees control of parking. Advocates view renting allotted slots to outsiders as impermissible in many societies.
- **Gap:** no marketplace offers societies **controlled, auditable, revenue-generating** outsider access (caps, hours, approved hosts, visitor logs, fund share). Today the society's only options are "allow informally" or "ban".
- **Confidence:** Medium. The problem is evident. Willingness of societies to participate is unproven, so it's the riskiest assumption.

## G4: EV owners in apartments can't charge at home, and nearby AC charging is missing
- **Evidence:** societies refuse private chargers (Noida fine of ₹25,000, Bengaluru case). The Bombay HC ruled against arbitrary refusal, and a Supreme Court petition is pending (2026). The public network (~24–27k stations) is concentrated on OMC and commercial sites and highways. Electric four-wheelers in India grew ~90% YoY to ~2.2 lakh in FY2025-26.
- **Gap:** **overnight or working-hours AC charging bundled with a parking spot, near home or office**, from hosts who already have a charger: independent houses, small businesses, commercial lots, willing societies.
- **Confidence:** Medium. The demand pain is strong, but supply willingness and electricity-resale rules are uncertain (R-26).

## G5: Charger sharing in India is hardware-led, which leaves "dumb" chargers out
- **Evidence:** Bolt.Earth's host model uses eligible connected chargers with per-unit pricing. Most home and small-business AC chargers and 15 A sockets aren't connected.
- **Gap:** a booking model that works for any compliant charger (per-session or per-hour pricing, parking included), plus an integration path for connected chargers.
- **Confidence:** Medium. It's unclear how many unconnected chargers hosts would actually list.

## G6: Host protection is absent in India
- **Evidence:** Neighbor offers a host guarantee and payment-default protection. Hosts in UK and California research cite liability and insurance as top concerns. No Indian peer-to-peer app shows comparable protection.
- **Gap:** clear liability terms, evidence capture at check-in, deposits or damage handling, payment guarantees for monthly hosts and, later, an insurance partner.
- **Confidence:** Medium.

## G7: Two-wheeler parking and charging (note, not a pilot target)
- **Evidence:** e-2Ws are ~57–60% of Indian EV sales (~1.4M in FY2025-26), and two-wheelers are a huge share of gate traffic. ANPR performs worse on 2W plates.
- **Gap:** largely unserved by private parking marketplaces.
- **Confidence:** Low–medium. Lower ticket size and operational cost per booking may not pay off. Keep it as a future asset and vehicle variant. Out of pilot scope unless the product owner decides otherwise.

---

## Gaps we should NOT chase

| Apparent gap | Why not |
|---|---|
| Ad-hoc hourly home charger sharing | UK evidence: thin demand, tiny earnings, high friction. Niche at best. |
| On-street / municipal parking digitisation | Fragmented control; history of failed Indian attempts; B2G sales cycle |
| Super-app car services | Park+ owns it; it doesn't help liquidity |
| Fast DC charging network | Capital-heavy CPO business |

---

## Validation of Phase 0 assumptions

| ID | Assumption | Phase 1 finding | Status |
|---|---|---|---|
| A1 | India, urban, one pilot city | Bengaluru and Mumbai show strong price anchors and policy pressure (paid street parking). The city choice remains a product-owner decision. | Supported |
| A2 | UPI-first, licensed aggregator with split settlement | Indian peers use UPI wallets and bank settlement (Bolt.Earth). Aggregator choice is for Phase 15. | Supported |
| A3 | Monthly / recurring drives liquidity | International leaders' earnings story is monthly and events. Indian monthly prices are meaningful. UK charger-sharing research shows repeat relationships keep hosts. | **Supported (strongly)** |
| A4 | Societies are the realistic unit of apartment supply | Bye-laws give committees control of parking; renting to outsiders is legally contested | **Supported**, and individual apartment hosts without society consent are a legal and trust risk |
| A5 | Commercial and off-hours supply has less friction | Consistent with ParkMate's B2B traction and Neighbor's SMB and investor focus | Supported (indirect) |
| A6 | No hardware; per-session or per-hour EV pricing | Supported as a differentiation angle (G5). Indian hardware-led competitor exists. | Supported |
| A7 | Guard verification without installing an app | Society apps already sit on guards' devices. **Better: integrate or hand off to existing visitor pre-approval where present**, with SMS or WhatsApp lookup elsewhere. | Refined |
| A8 | Approximate location before booking is acceptable | Hosts explicitly fear address exposure (UK study). No contrary evidence. | Supported (host side) |
