# Competitive Analysis

Phase 1 output, researched 2026-10-19. Figures are as reported by the cited sources, which are often company-sourced or secondary. Treat them as directional, not audited. Sources are listed at the end.

Related: [market-gaps.md](market-gaps.md) · [differentiation-strategy.md](differentiation-strategy.md) · [product-discovery.md](product-discovery.md)

---

## 1. Landscape at a glance

| Segment | Players | What they actually do | Threat to us |
|---|---|---|---|
| Indian car-owner super-app | **Park+** | FASTag issuer (among the largest non-bank), parking discovery and booking at operator and government lots, gate and access automation at airports, malls and 3,000+ residential gates; dealership and car services | **High.** Has distribution, gate hardware in societies and capital. Not peer-to-peer today. |
| Indian peer-to-peer and private parking apps | ParkingMudde, ParkForRent, ParkSpot, Parksy (listings), ShowMyParking | Owners list spaces, set price, earn. Small, mostly self-described, little independent evidence of traction or verification depth. | Medium–low. They prove the idea exists. None appears to have solved trust and access. |
| Indian parking operations / B2B | Get My Parking, ParkWheels, ParkMate, ParkZap | Operator software, RFID/ANPR/FASTag gate automation, valet. ParkMate pivoted from consumer to corporate and B2G valet and SaaS. | Low as competitors; **potential access partners.** |
| Society management apps | **MyGate**, **NoBrokerHood**, ADDA | Visitor management, guard apps, gate hardware integration, society ERP. NoBrokerHood claims 25,000+ communities; MyGate claims 4M+ households. | **High as gatekeepers.** They own the guard's phone at the gate. Partner or integrate, not compete. |
| Indian public EV charging | IndianOil and other OMCs (largest by count), Tata Power EZ Charge (~5,500–6,700 points reported), Jio-bp pulse (~5,000 points, targeting 30,000 by 2030), Statiq, ChargeZone, Zeon, GLIDA | Public AC and DC charging stations, mostly fast DC on highways and at commercial sites. Public network ~24,000–27,000 stations in 2025. | Low–medium. Different product: public, hardware-owned. They don't serve "overnight near home for apartment residents". |
| Indian EV charger sharing | **Bolt.Earth**, Kazam | Bolt.Earth: hosts list chargers (public paid, public free or private), set a per-unit price, users pay from a UPI-funded wallet, settlement to the host's bank. **Hardware- and IoT-led** (connected chargers, QR scan). Kazam: platform and OS for CPOs, fleets and properties. | **Medium–high for EV.** Bolt.Earth is the closest Indian analogue on the EV side, but needs connected hardware. |
| International peer-to-peer parking | **JustPark** (UK), YourParkingSpace (UK), Spacer (AU, acquired Parkhound and WhereiPark), Stashbee, **Neighbor** (US storage and parking), SpotHero (started peer-to-peer, became garages, **acquired by Uber for ~$600M, closed Apr 2026**) | Marketplaces for driveways, garages and commercial spaces. Monthly and event demand. | None directly in India. They're **reference models.** |
| International peer-to-peer EV charging | Co Charger (UK), JustPark JustCharge, Plugable (UK), PlugShare home listings | Home charger sharing. PlugShare does discovery and messaging only, with payment and access handled off-platform. | Reference models. Research shows a niche, thin-demand segment. |

---

## 2. Key competitors in detail

### Park+ (India)
- **Strengths:** large user base via FASTag; profitable-from-start claims; ~$340M valuation at Series C (2023); B2B gate and access automation already deployed at 3,000+ residential gates; government parking partnerships (Maha Kumbh 2025).
- **Weaknesses:** super-app breadth (FASTag, challans, insurance, dealerships). Parking booking is focused on operator and government lots, not private residential supply. Complaints exist about being turned away at a booked lot with no refund, and about FASTag recharges not credited (individual complaints, not a representative sample).
- **Takeaway:** the most likely incumbent to enter peer-to-peer parking. Its gate footprint is both a threat and a signal that **society gate access is the strategic chokepoint**.

### MyGate / NoBrokerHood / ADDA (India)
- **Strengths:** installed on the guard's device and the residents' phones in tens of thousands of societies. Visitor pre-approval flows already exist. ADDA integrates RFID and ANPR boom barriers.
- **Weaknesses:** a society tool, not a marketplace. No demand-side discovery or payments for outsiders. Privacy concerns reported (2025).
- **Takeaway:** the **guard verification problem (PJ-2) has already been half-solved by these apps.** Integration, or a visitor pre-approval handoff, could beat building our own guard channel in societies that use them.

### Bolt.Earth (India, EV)
- **Strengths:** a working host model in India: modes per charger (public paid, public free, private), host-set per-unit pricing, wallet via UPI, bank settlement, availability scheduling.
- **Weaknesses:** tied to eligible connected chargers. Per-unit pricing requires metering. EV-only, so no parking-first product and no parking monetisation for hosts.
- **Takeaway:** don't compete head-on on connected-charger hardware. Our angle is **parking + charging as one booking**, works with any compliant charger (including unmetered), with a later integration path to connected chargers (CLAUDE.md §4).

### JustPark (UK): the closest model for our parking product
- **Pricing:** free to list; **3% owner fee** on bookings (official); drivers pay a separate driver fee. Third-party sources report a higher first-month commission on long-term (2+ month) bookings (unconfirmed).
- **Host earnings:** typically £500–£3,000 per year per space (company figure). Monthly and event demand are the earnings story. Scheduled event pricing is supported.
- **Takeaway:** monetisation leans on the **demand side** (driver fee), keeping host take low to grow supply.

### YourParkingSpace (UK)
- **Pricing:** adds a **20% uplift to the host's price** (paid by the driver) plus a **3% processing fee** off host earnings.
- **Takeaway:** confirms the pattern: the host sees a low cut, and the customer pays a visible service fee.

### Neighbor (US)
- **Pricing:** free to list; hosts pay **4.9% + $0.30** processing; renters pay a service fee; the platform collects and pays sales tax in many areas.
- **Trust:** **$1M Host Guarantee** (secondary to the host's own insurance, discretionary per critics); renter protection plans; **guaranteed payments to the host if a renter defaults**; host controls who rents and access times.
- **Takeaway:** host protection and payment guarantees are core to supply acquisition for long-term rentals.

### Co Charger / JustCharge / Plugable (UK, EV sharing)
- **Model:** hosts list a home charger, set price, approve bookings; recurring or on-demand slots; the platform takes a share.
- **Evidence (UK host study, 16 hosts, June 2025):** thin and irregular demand (bookings months apart); earnings "not worth a couple of pounds" for some; liability and insurance uncertainty (home insurers may decline cover); overstay after charging; billing based on self-reported departure; privacy concerns (address on public maps). What kept hosts active: **repeat, hyper-local relationships with known users**, low coordination effort and a fair price.
- **Takeaway:** ad-hoc home charger sharing is a **niche complement**, not a mass market. Recurring neighbourhood matching is what works.

### Indian parking startups: lessons from history
- Earlier startups (ParkWheels, Get My Parking, Rhino Park) found that **the European model of online pre-booking of public parking didn't fit India**. Parking is controlled by a fragmented mix of municipal bodies, contractors, market associations and local operators.
- ParkMate's consumer launch failed on perception (it was mistaken for a municipal affiliate). It found traction in **B2B/B2G**, where contracts substitute for personal trust.
- **Takeaway:** in India, trust is personal and institutional. Consumer adoption follows visible, accountable trust signals and institutional partners.

---

## 3. Patterns across the market

### Pricing approaches
| Platform | Host take | Customer fee | Notes |
|---|---|---|---|
| JustPark | 3% (higher on first month of long-term, unconfirmed) | Driver fee | Low host take |
| YourParkingSpace | 3% | +20% uplift | Most revenue from the demand side |
| Neighbor | 4.9% + $0.30 | Service fee | Plus host guarantee |
| Co Charger | Share of booking (undisclosed) | n/a | |
| Bolt.Earth | "Applicable fees" (undisclosed) | n/a | Per-unit pricing |

**Pattern:** successful peer-to-peer parking marketplaces keep the **visible host cut low** and earn mainly through a **customer service fee**. Hosts compare their payout with their set price, while customers compare the total with alternatives.

### Indian price anchors (asking prices, approximate)
- Monthly covered parking, Bengaluru: **₹2,500–₹4,500/month** (Parksy listings).
- Monthly parking, Mumbai: **₹5,000–₹15,000/month** depending on locality.
- Bengaluru on-street residential permits (proposed under Parking Policy 2.0): ₹1,000–₹5,000 per year by vehicle size, with no guaranteed spot. The draft Greater Bengaluru Authority (Parking) Rules, 2026 were published for objections in August 2026. **Paid street parking pushes demand toward private off-street options.**

### Trust mechanisms seen
- Host guarantees and damage cover (Neighbor), with fine print critics call discretionary.
- Payment guarantees to hosts (Neighbor).
- Contact masking (ParkingMudde claims masked calls).
- Host controls: who can book, booking approval, access times (Neighbor, Co Charger).
- Reviews (universal). Research and our own principles say these aren't sufficient on their own.

### Access mechanisms seen
- QR scan at charger (Bolt.Earth).
- RFID windscreen tags (FASTag-like), ANPR, and FASTag + ANPR two-factor at society gates (ADDA, ParkZap, Park+). ANPR accuracy is reported at ~90–95% in daytime and worse at night and for two-wheeler plates (anecdotal and vendor figures).
- Visitor pre-approval through society apps (MyGate, NoBrokerHood).
- Plain instructions plus host coordination (most peer-to-peer platforms). This is where failures happen.

### Supply acquisition strategies
- Free listing with earnings calculators (JustPark, Neighbor, Spacer: "could your spot earn $450/month?").
- Targeting real-estate investors and SMBs with multiple spaces (Neighbor).
- Event-area homeowners (JustPark).
- B2B and property-level deals (Kazam, Park+ gates, ParkMate).

### Demand acquisition strategies
- Commuter, event and airport demand (SpotHero, now inside Uber).
- Distribution through super-apps (Park+ via FASTag, Uber via SpotHero).
- SEO listing pages per locality (Parksy, JustPark).

---

## 4. Customer and host complaints

**Customers**
- Booked, turned away at the gate, no refund (Park+ complaint, 2024).
- Slow refunds and poor support when something goes wrong (ParkWhiz, ParkMobile; international).
- Peer-to-peer EV: charger unreliability, liability for damage to the EV from faulty equipment, not finding a charger when needed (California survey, 350+ EV households).

**Hosts**
- Thin and irregular demand; small earnings relative to effort (UK host study).
- Liability and insurance uncertainty; damage to the charger (UK and California studies).
- Overstay; disputes over minor issues; payment collected after the fact.
- Privacy: home address visible on maps, routines revealed.
- Poor platform support (Co Charger, as reported by one host).

**Societies (India)**
- Refusing EV chargers over sanctioned load, fire safety and wiring. Fines imposed on residents (Noida case: ₹25,000). The Bombay HC ruled in early 2025 that societies can't arbitrarily refuse. A Supreme Court petition was filed in January 2026 seeking enforcement of the MoP 2024 guidelines. **The legal position is still settling.**
- Treating allotted parking as society-controlled. Maharashtra model bye-laws (78–84) give the managing committee control of parking. Several advocates view renting an allotted slot to an outsider as impermissible. Tenants living in the flat have stronger rights.

---

## 5. Features not worth copying

| Feature | Why not |
|---|---|
| FASTag issuance, challans, insurance, dealership (Park+ super-app) | Huge scope, regulatory overhead, nothing to do with marketplace liquidity |
| Own charger hardware / IoT network (Bolt.Earth, CPOs) | Capital-heavy, and contradicts CLAUDE.md §4 (no hardware assumption). Integrate later instead. |
| Per-kWh pricing without metering | Unverifiable. Source of disputes (UK study: billing on self-reported times). |
| Public / on-street parking operation | Fragmented municipal control; the history of Indian startups shows poor fit |
| Valet | Operations-heavy, a different business (ParkMate pivot) |
| Discovery-only listings with off-platform payment (PlugShare home) | No guarantees, no recourse, and leakage is built in |
| Our own guard and visitor app for societies that already use MyGate / NoBrokerHood / ADDA | Competing for the guard's attention. Integrate or hand off instead. |
| Celebrity / mass-marketing launch | Indian parking adoption follows local, visible trust, not awareness (ParkMate) |

---

## Sources

- Park+ funding and business: [z47 Series C](https://z47.com/news/matrix-backed-park-raises-17m-in-series-c-round), [parking.net Series C](https://www.parking.net/parking-news/park-raises-17-million-in-funding-from-epiq-capital-sequoia-and-matrix), [Peak XV](https://www.peakxv.com/companies/park), [afaqs: Maha Kumbh 2025](https://www.afaqs.com/news/mktg/park-launches-fastag-enabled-parking-system-for-maha-kumbh-2025-8600867), [Park+ review (Parksy)](https://www.parksy.com/blog/park-india-parking-review)
- Park+ complaints: [ConsumerComplaints.in](https://www.consumercomplaints.in/bycompany/park-plus-a640795.html)
- Indian peer-to-peer parking apps: [ParkingMudde](https://parkingmudde.com/), [ParkForRent](https://www.parkforrent.com/), [ParkSpot](https://play.google.com/store/apps/details?id=com.parkspot.maya_nagri&hl=en-US), [ShowMyParking](https://showmyparking.com/smpweb/), [Parksy Bangalore](https://www.parksy.com/garages/bangalore)
- Indian parking startups: [Inc42 on ParkMate](https://inc42.com/startups/can-parkmate-put-an-end-to-indias-parking-chaos), [MediaNama on Get My Parking](https://www.medianama.com/2018/04/223-smart-parking-startup-get-my-parking-acquires-constapark/), [ElectronicsForU on ParkWheels](https://www.electronicsforu.com/electronics-startups/an-iot-venture-transforming-indias-parking-industry)
- Society apps and gates: [NoBrokerHood](https://www.nobrokerhood.com/blog/mygate-alternative/), [MyGate alternatives 2026](https://codingclave.com/blog/mygate-alternatives-india-2026), [ADDA gate automation](https://blog.ind.adda.io/2020/02/guide-to-automated-gate-rfid-anpr-apartments/), [ParkZap](https://parkzap.com/), [Team-BHP ANPR thread](https://www.team-bhp.com/forum/street-experiences/257036-automatic-number-plate-recognition-system-replace-fastags.html), [Studio Matrx ANPR India](https://www.studiomatrx.org/guides/anpr-cctv-cameras-india)
- Indian EV charging: [electrive Jan 2026](https://www.electrive.com/2026/01/09/indias-ev-momentum-accelerates-as-charging-network-expands-and-car-sales-surge), [Mobility Outlook / Tata.ev](https://www.mobilityoutlook.com/analysis/indias-public-ev-charging-network-hits-new-highs-in-2025-tataev/), [S&P on Jio-bp](https://autotechinsight.spglobal.com/news/5280500/jio-bp-aims-to-install-over-30000-ev-charging-points-across-india-by-2030), [Bolt.Earth host guide](https://bolt.earth/blog/how-to-use-bolt-earth-ev-charging-app-guide-to-setup-chargers-and-rewards), [TechCrunch on Kazam](https://techcrunch.com/2024/08/11/indias-kazam-powers-up-to-roll-out-ev-charging-in-southeast-asia)
- Indian EV sales: [EVreporter FY2025-26](https://evreporter.com/india-sold-2550865-electric-vehicles-across-categories-in-fy-2025-26/), [Autocar Pro e-2W FY2026](https://www.autocarpro.in/analysis-sales/record-14-million-electric-2ws-sold-in-fy2026-command-57-share-of-india-ev-market-131938)
- Societies and EV chargers: [Down To Earth: Supreme Court](https://www.downtoearth.org.in/air/india-on-e-wheels-can-a-housing-society-block-your-ev-charger-supreme-court-may-soon-decide), [Down To Earth: Right to Charge](https://www.downtoearth.org.in/air/beyond-the-courts-why-india-needs-a-statutory-right-to-charge-to-fuel-its-ev-revolution), [Cartoq: Noida case](https://svb1.cartoq.com/car-life/ev-charging-denied-housing-society-safety-standoff-sparks-legal-battle)
- Society parking rules: [Moneylife: Maharashtra bye-laws](https://www.moneylife.in/lrc/chs-property-related-issues/additional-parking-charges-as-per-maharashtra-housing-society-bye-laws/5368.html), [Kaanoon Q&A](https://www.kaanoon.com/419353/alloted-parking-in-coop-society-on-rent), [Conventus Law: tenants' parking](https://conventuslaw.com/report/india-its-settled-tenants-are-entitled-to-owners/)
- Price anchors: [Housiey: Mumbai parking](https://housiey.com/blogs/should-you-pay-extra-for-parking-spaces), [Deccan Herald: Bengaluru policy](https://www.deccanherald.com/india/karnataka/bengaluru/roadside-parking-in-bengaluru-to-get-costlier-as-new-policy-gets-nod-949866.html), [Citizen Matters: 2026 draft rules](https://citizenmatters.in/big-promises-unheard-residents-bengalurus-new-parking-rules-need-a-rethink/)
- International: [JustPark owner fee](https://support-uk.justpark.com/hc/en-gb/articles/207336687), [JustPark rental guide](https://www.justpark.com/rental-price-guide/), [MoneySavingExpert](https://moneysavingexpert.com/shopping/cheap-parking-rental/), [YourParkingSpace commission](https://support.yourparkingspace.co.uk/hc/en-us/articles/211994145-Do-you-charge-commission), [Neighbor host](https://neighbor.com/host), [sidehusl Neighbor review](https://sidehusl.com/neighbor/), [Spacer hosts](https://www.spacer.com/fr/how-it-works-for-hosts), [Inside Self-Storage: Spacer/Parkhound](https://www.insideselfstorage.com/facility-operators/australia-based-peer-to-peer-self-storage-operator-spacer-raises-2-7m-buys-parkhound), [Uber 10-Q (SpotHero)](https://www.sec.gov/Archives/edgar/data/0001543151/000154315126000022/uber-20260331.htm), [Nasdaq: Uber–SpotHero](https://www.nasdaq.com/articles/uber-acquire-spothero-add-app-parking-reservations)
- Peer-to-peer EV research: [Frontiers 2026 UK host study](https://www.frontiersin.org/journals/sustainable-cities/articles/10.3389/frsc.2026.1752469/full), [UCI Dean Lab survey](https://faculty.sites.uci.edu/deanlab/?p=656), [ChargeGuru: Co Charger](https://chargeguru.com/uk/co-charger/), [Forecourt Trader: Plugable](https://forecourttrader.co.uk/latest-news/plugable-unlocks-access-to-private-ev-chargers/693255.article)
