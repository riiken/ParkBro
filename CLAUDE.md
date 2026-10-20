# MOBILITY INFRASTRUCTURE MARKETPLACE
# PROJECT CONSTITUTION

You are building a production-grade marketplace platform that connects people and properties with underutilized private mobility infrastructure to customers who need that infrastructure.

The initial marketplace categories are:

1. Private parking
2. Private EV charging

The long-term vision is:

> Build a trusted marketplace where people, properties, apartments, societies and businesses can monetize underutilized mobility infrastructure while customers can discover, reserve, pay for and access that infrastructure conveniently.

This document is the permanent engineering, product, security, architecture and AI constitution of the project.

============================================================
1. CORE PRODUCT VISION
============================================================

The platform connects:

ASSET OWNER / HOST
        ↓
UNDERUTILIZED INFRASTRUCTURE
        ↓
MARKETPLACE
        ↓
CUSTOMER / DRIVER
        ↓
DISCOVER → BOOK → PAY → ACCESS → USE → REVIEW

The host earns money.

The customer gets convenient infrastructure.

The platform earns a commission.

The initial asset categories are:

PARKING
EV CHARGING

The architecture must eventually support additional mobility-related infrastructure without requiring a complete rewrite.

Possible future categories:

- Car washing
- Car detailing
- Service bays
- Battery services
- Vehicle-related services
- Other compatible private infrastructure

Do not implement future categories unless explicitly required.

============================================================
2. CORE PRODUCT PRINCIPLE
============================================================

Do NOT build two completely separate products for parking and EV charging.

Use a generic asset marketplace architecture:

ASSET
 ↓
AVAILABILITY
 ↓
DISCOVERY
 ↓
BOOKING
 ↓
PAYMENT
 ↓
ACCESS
 ↓
USAGE
 ↓
REVIEW

Parking and EV charging are asset types.

This architecture must make future asset categories possible.

============================================================
3. INITIAL PARKING PRODUCT
============================================================

Parking may include:

- Apartment parking
- Residential parking
- Independent house parking
- Commercial/private property parking
- Covered parking
- Open parking
- Hourly parking
- Daily parking
- Overnight parking
- Monthly parking
- Recurring parking
- EV-compatible parking

Parking listing information may include:

- Location
- Approximate map location
- Photos
- Dimensions
- Vehicle compatibility
- Covered/open
- Security
- CCTV
- Gate access
- Rules
- Availability
- Pricing
- EV compatibility
- Access instructions

============================================================
4. INITIAL EV CHARGING PRODUCT
============================================================

EV charging listings may include:

- Charger type
- Connector
- AC/DC
- Power
- Charging speed
- Pricing
- Availability
- Parking availability
- Access method
- Usage rules

Pricing may eventually support:

- Per kWh
- Per session
- Per hour
- Hybrid models

Do not assume hardware integration exists.

Design an abstraction so smart charger integrations can be added later.

============================================================
5. USER TYPES
============================================================

CUSTOMER / DRIVER

Can eventually:

- Register
- Verify identity where required
- Manage vehicle
- Discover assets
- Search nearby
- Filter
- View listings
- Check availability
- Book
- Pay
- Cancel
- Reschedule where supported
- Navigate
- Access
- Use the asset
- View history
- Review hosts
- Raise disputes

HOST / ASSET OWNER

Can eventually:

- Register
- Verify identity where required
- Create assets
- Upload photos
- Configure availability
- Configure pricing
- Publish listings
- Receive bookings
- Manage bookings
- Block availability
- View earnings
- Manage payouts
- Review customers
- Handle disputes

PROPERTY / SOCIETY ADMINISTRATOR

Future capability.

May manage:

- Properties
- Buildings
- Parking inventory
- Hosts
- Society rules
- Access
- Marketplace participation
- Revenue sharing

PLATFORM ADMIN

Can manage:

- Users
- Hosts
- Properties
- Assets
- Bookings
- Payments
- Payouts
- Verification
- Reviews
- Disputes
- Fraud
- Platform configuration
- Analytics

============================================================
6. PRODUCT DEVELOPMENT PRINCIPLE
============================================================

Do not optimize for the number of features.

Optimize for:

- Trust
- Safety
- Reliability
- Marketplace liquidity
- Simple UX
- Correct booking behavior
- Correct financial behavior
- Privacy
- Maintainability
- Scalability
- Real user value

A reliable core booking experience is more important than a large feature list.

============================================================
7. DISCOVERY BEFORE DEVELOPMENT
============================================================

Before implementing major functionality:

- Understand the product
- Understand users
- Understand the marketplace
- Understand business rules
- Understand risks
- Understand technical constraints
- Understand trust requirements
- Understand location/privacy concerns
- Understand payment requirements
- Understand access requirements
- Understand future scalability requirements

Never blindly start coding.

When a phase is primarily discovery/research/design, do not implement unrelated application features.

============================================================
8. MARKETPLACE PRINCIPLE
============================================================

The product is a two-sided marketplace.

Supply:

HOST
 ↓
LIST ASSET
 ↓
CONFIGURE AVAILABILITY
 ↓
CONFIGURE PRICE
 ↓
PUBLISH

Demand:

CUSTOMER
 ↓
SEARCH
 ↓
DISCOVER
 ↓
CHECK AVAILABILITY
 ↓
BOOK
 ↓
PAY
 ↓
ACCESS
 ↓
USE

Platform:

CUSTOMER PAYMENT
 ↓
PLATFORM
 ├── COMMISSION
 ├── APPLICABLE FEES/TAXES
 └── HOST PAYABLE
          ↓
       PAYOUT

Keep these financial concepts separate.

============================================================
9. MARKETPLACE LIQUIDITY
============================================================

Marketplace success is not simply:

- Downloads
- Registered users
- Number of features

Important metrics include:

- Search volume
- Search-to-booking conversion
- Asset availability
- Asset utilization
- Booking success rate
- Repeat bookings
- Host retention
- Customer retention
- Average booking value
- Cancellation rate
- No-show rate
- Supply density
- Demand density

Critical marketplace question:

> Can a customer reliably find a suitable asset nearby when they need it?

============================================================
10. TRUST & SAFETY
============================================================

The platform may allow strangers to access:

- Apartment complexes
- Residential buildings
- Private homes
- Private properties
- Charging locations

Trust and safety are first-class product capabilities.

Potential verification:

- Phone
- Email
- Identity
- Vehicle
- Host
- Property
- Asset

Use risk-based verification.

Do not unnecessarily require expensive verification for every user.

============================================================
11. LOCATION PRIVACY
============================================================

Residential asset locations are sensitive.

Do not expose exact residential information unnecessarily.

Use privacy-aware location handling.

Potential model:

Before booking:
- Approximate location

After booking:
- Appropriate exact access information

Never expose private host information unnecessarily.

============================================================
12. BOOKING ENGINE
============================================================

Booking must be generic and asset-independent.

Conceptual booking:

- Booking ID
- Customer
- Host
- Property
- Asset
- Asset type
- Start time
- End time
- Price
- Fees
- Commission
- Payment state
- Booking state
- Access state
- Cancellation state
- Created timestamp
- Updated timestamp
- Audit information

Use explicit states.

Do not scatter arbitrary booking status strings throughout the codebase.

============================================================
13. AVAILABILITY
============================================================

Availability is authoritative application state.

The LLM must NEVER determine availability.

Availability must come from:

- Database
- Booking engine
- Availability rules
- External systems where applicable

Prevent:

- Double booking
- Race conditions
- Stale availability
- Concurrent booking conflicts
- Incorrect timezone handling

Booking creation must re-check availability immediately before committing.

============================================================
14. CONCURRENCY
============================================================

Critical marketplace operations must be concurrency-safe.

Especially:

- Booking
- Cancellation
- Rescheduling
- Payment confirmation
- Refund
- Payout
- Availability changes

Use appropriate:

- Transactions
- Locks
- Constraints
- Idempotency
- Optimistic concurrency
- Unique constraints

Choose based on actual requirements.

============================================================
15. PAYMENTS
============================================================

Payment state is authoritative backend state.

Never trust only frontend payment callbacks.

Use:

- Payment provider webhooks
- Signature verification
- Idempotency
- Explicit payment states
- Reconciliation
- Refund handling
- Cancellation handling

Never mark a payment successful based solely on client input.

============================================================
16. PAYOUTS
============================================================

Keep:

Customer payment

separate from:

Host earnings

separate from:

Platform commission

separate from:

Payout

Maintain transaction/audit records.

============================================================
17. ACCESS MANAGEMENT
============================================================

Access may eventually support:

- OTP
- QR
- Digital pass
- Vehicle number
- Security approval
- Gate approval
- Smart locks
- ANPR
- Society integrations

Do not hard-code a single access mechanism into the core architecture.

Access must depend on valid authorization.

Log important access events.

============================================================
18. DISPUTES
============================================================

Disputes are first-class entities.

Potential disputes:

- Parking unavailable
- Incorrect listing
- Access failure
- Vehicle damage
- Property damage
- Charger failure
- Incorrect billing
- No-show
- Host cancellation
- Customer misconduct

Potential evidence:

- Photos
- Booking logs
- Access logs
- Payment records
- Communication records
- Timestamps

High-risk disputes must not be automatically resolved by an LLM.

============================================================
19. REVIEWS & TRUST
============================================================

Support two-sided reviews where appropriate.

Customer → Host

Host → Customer

Potential dimensions:

- Accuracy
- Communication
- Cleanliness
- Safety
- Access experience
- Reliability

Eventually support trust scores.

Do not use ratings as the only safety/fraud mechanism.

============================================================
20. NOTIFICATIONS
============================================================

Important events may include:

- Booking confirmed
- Booking reminder
- Booking starting
- Booking ending
- Charging started
- Charging completed
- Cancellation
- Refund
- Payment received
- Payout completed
- Dispute opened
- Verification required

Potential channels:

- Push
- WhatsApp
- SMS
- Email

Use provider abstraction.

============================================================
21. AI PRINCIPLES
============================================================

AI is an intelligence layer.

AI is NOT the source of truth.

Potential AI capabilities:

- Natural-language parking search
- Natural-language EV search
- Recommendations
- AI parking assistant
- AI EV assistant
- Host assistant
- Revenue insights
- Demand forecasting
- Pricing recommendations
- Customer support
- Dispute assistance
- Natural-language analytics

For AI actions use:

USER
 ↓
LLM
 ↓
STRUCTURED INTENT
 ↓
VALIDATION
 ↓
AUTHORIZATION
 ↓
APPLICATION TOOL
 ↓
DETERMINISTIC BUSINESS LOGIC
 ↓
DATABASE / EXTERNAL SYSTEM
 ↓
RESULT
 ↓
LLM RESPONSE

The LLM must never directly:

- Modify database records
- Create arbitrary bookings
- Change payment state
- Change payout state
- Bypass authorization
- Access arbitrary tables
- Execute arbitrary code

============================================================
22. AI SAFETY
============================================================

AI must never hallucinate:

- Availability
- Booking status
- Payment status
- Payout status
- User authorization
- Access authorization

These must come from deterministic systems.

Every AI feature must define:

- User problem
- Why AI
- Required data
- Model
- Prompt strategy
- Structured output
- Tools
- Validation
- Authorization
- Hallucination risk
- Privacy risk
- Cost
- Latency
- Fallback
- Evaluation

============================================================
23. DATABASE
============================================================

Prefer PostgreSQL for production.

Use relational modeling for:

- Users
- Vehicles
- Hosts
- Properties
- Assets
- Availability
- Bookings
- Payments
- Refunds
- Payouts
- Reviews
- Disputes
- Verification
- Access
- Notifications
- Audit logs

Use indexes based on actual query patterns.

Do not over-engineer.

============================================================
24. ARCHITECTURE
============================================================

Start with a modular monolith unless evidence strongly justifies microservices.

Recommended conceptual modules:

- Identity
- Users
- Properties
- Assets
- Discovery
- Availability
- Booking
- Pricing
- Payments
- Payouts
- Access
- Notifications
- Reviews
- Trust
- Disputes
- Admin
- Analytics
- AI

Maintain clear module boundaries.

============================================================
25. API
============================================================

APIs must have:

- Authentication
- Authorization
- Validation
- Consistent errors
- Request IDs
- Idempotency where appropriate
- Rate limiting where appropriate
- Logging
- Tests

Never trust frontend input.

============================================================
26. SECURITY
============================================================

Protect:

- Credentials
- Payment information
- Identity information
- Vehicle information
- Residential locations
- Host information
- Access credentials
- API keys
- Webhook secrets

Never:

- Commit secrets
- Log secrets
- Expose secrets
- Trust client-side authorization
- Expose sensitive data unnecessarily

============================================================
27. OBSERVABILITY
============================================================

Production architecture should eventually support:

- Structured logs
- Request IDs
- Metrics
- Error tracking
- Health checks
- Database monitoring
- Payment monitoring
- Booking monitoring
- Notification monitoring
- AI cost tracking
- AI latency tracking

============================================================
28. UX PRINCIPLES
============================================================

Customer:

OPEN
 ↓
SEARCH
 ↓
UNDERSTAND OPTIONS
 ↓
BOOK
 ↓
PAY
 ↓
ACCESS
 ↓
USE
 ↓
COMPLETE

Host:

REGISTER
 ↓
LIST
 ↓
SET AVAILABILITY
 ↓
SET PRICE
 ↓
PUBLISH
 ↓
RECEIVE BOOKINGS
 ↓
EARN

Minimize unnecessary steps.

Always provide:

- Loading states
- Empty states
- Error states
- Success states
- Retry paths
- Clear confirmations

============================================================
29. TESTING
============================================================

Critical functionality requires automated tests.

At minimum:

- Authentication
- Authorization
- Asset creation
- Availability
- Booking
- Concurrent booking
- Cancellation
- Rescheduling
- Payment webhook
- Refund
- Payout calculation
- Notifications
- Access
- Disputes
- AI tool authorization

Do not call a feature complete without appropriate tests.

============================================================
30. DOCUMENTATION
============================================================

Maintain useful documentation under:

docs/

Possible documents:

- product-discovery.md
- user-personas.md
- core-user-journeys.md
- business-model.md
- competitive-analysis.md
- market-gaps.md
- differentiation-strategy.md
- domain-model.md
- ux-architecture.md
- architecture.md
- database-design.md
- api-design.md
- trust-and-safety.md
- ai-strategy.md
- analytics.md
- risk-register.md
- implementation-roadmap.md
- production-readiness.md
- launch-checklist.md
- decision-log.md

Documentation should capture useful decisions, not generate unnecessary paperwork.

============================================================
31. DEVELOPMENT RULES
============================================================

For every implementation phase:

1. Read CLAUDE.md.
2. Read relevant phase instructions.
3. Read previous documentation.
4. Inspect current implementation.
5. Review existing architecture.
6. Plan before coding.
7. Implement only the current phase.
8. Write tests.
9. Run tests.
10. Review security.
11. Review performance.
12. Review UX.
13. Update documentation.
14. Update project status.
15. Verify acceptance criteria.
16. Only then proceed.

Do not silently change product requirements.

Do not introduce unnecessary dependencies.

Do not over-engineer.

Do not prematurely introduce microservices.

Do not prematurely introduce Kubernetes.

Do not introduce vector databases merely because AI is planned.

Do not introduce event streaming merely because the product may scale.

Use the simplest architecture that can safely support the current requirements.

============================================================
32. PHASE DISCIPLINE
============================================================

PHASES.md contains the complete execution roadmap.

Each phase must be completed sequentially.

Never skip a phase without explicitly documenting why.

Never implement large parts of future phases early.

If a dependency from a future phase is required, implement only the minimum foundation and document it.

============================================================
33. FINAL PRODUCT PRINCIPLE
============================================================

Build a real marketplace, not a demo.

The system must eventually be capable of handling:

- Real users
- Real hosts
- Real properties
- Real assets
- Real bookings
- Real payments
- Real payouts
- Real disputes
- Real access
- Real location privacy
- Real failures
- Real operational problems

When choosing between:

FLASHY FEATURE

and

RELIABLE CORE SYSTEM

choose the reliable core system.

END OF CLAUDE.md