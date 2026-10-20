# MOBILITY INFRASTRUCTURE MARKETPLACE
# COMPLETE IMPLEMENTATION PHASES

============================================================
GLOBAL EXECUTION INSTRUCTIONS
============================================================

This file contains the complete product development roadmap.

You must execute phases sequentially.

Do NOT treat these as independent prompts.

Every phase depends on the implementation, decisions, documentation and lessons from previous phases.

Before doing anything:

1. Read CLAUDE.md completely.
2. Read this PHASES.md.
3. Inspect the current repository.
4. Read PROJECT_STATUS.md if it exists.
5. Read all relevant documentation.
6. Identify the last completed phase.
7. Continue from the first incomplete phase.

Never assume previous implementation is perfect.

Always review it.

============================================================
MANDATORY PHASE LIFECYCLE
============================================================

EVERY PHASE MUST FOLLOW:

READ
 ↓
UNDERSTAND
 ↓
REVIEW
 ↓
PLAN
 ↓
IMPLEMENT
 ↓
TEST
 ↓
SELF-REVIEW
 ↓
SECURITY REVIEW
 ↓
DOCUMENT
 ↓
UPDATE PROJECT STATUS
 ↓
VERIFY ACCEPTANCE CRITERIA
 ↓
MARK COMPLETE
 ↓
CONTINUE

============================================================
STEP 1 — READ
============================================================

Read:

- CLAUDE.md
- Current phase
- Relevant previous phases
- Relevant documentation
- Existing implementation
- Existing tests

============================================================
STEP 2 — UNDERSTAND
============================================================

Understand:

- Why this phase exists
- What user problem it solves
- What previous phases established
- What current architecture supports
- What constraints exist

Do not start coding before understanding the current state.

============================================================
STEP 3 — REVIEW
============================================================

Before implementation review:

- Architecture
- Database
- APIs
- Frontend
- Backend
- Security
- UX
- Existing tests
- Existing business rules

Identify:

- Missing functionality
- Incorrect implementation
- Technical debt
- Security problems
- Performance problems
- Product inconsistencies
- Architecture problems

Fix blocking issues where appropriate.

============================================================
STEP 4 — PLAN
============================================================

Before coding, create a concise implementation plan.

Include:

- Modules affected
- Files likely affected
- Database changes
- API changes
- Frontend changes
- External integrations
- Tests
- Security concerns
- Migration concerns
- Rollback considerations

Do not over-engineer.

============================================================
STEP 5 — IMPLEMENT
============================================================

Implement ONLY the current phase.

Do not implement future phases.

Do not rewrite working code without a clear reason.

Preserve existing functionality.

============================================================
STEP 6 — TEST
============================================================

Run appropriate:

- Unit tests
- Integration tests
- API tests
- Frontend tests
- End-to-end tests
- Type checking
- Linting
- Build

Test:

- Happy path
- Invalid input
- Unauthorized access
- Duplicate requests
- Concurrency
- Failure cases
- Boundary conditions

============================================================
STEP 7 — SELF REVIEW
============================================================

Act as a senior engineer reviewing your own work.

Ask:

- Is it production quality?
- Is it secure?
- Is it maintainable?
- Is it unnecessarily complex?
- Did I introduce duplication?
- Did I break previous functionality?
- Are APIs consistent?
- Are database queries efficient?
- Are errors handled?
- Are logs useful?
- Is the UX clear?
- Does this actually solve the intended user problem?

Fix discovered problems.

============================================================
STEP 8 — SECURITY REVIEW
============================================================

Review:

- Authentication
- Authorization
- Input validation
- Data exposure
- PII
- Location privacy
- Payment security
- Webhooks
- Secrets
- Abuse
- Rate limiting

============================================================
STEP 9 — DOCUMENT
============================================================

Update relevant documentation.

Document:

- Important decisions
- Business rules
- Architecture changes
- API changes
- Database changes
- Security decisions
- Known limitations
- Technical debt

============================================================
STEP 10 — PROJECT STATUS
============================================================

Maintain:

PROJECT_STATUS.md

It must contain:

CURRENT PHASE
STATUS

COMPLETED PHASES

CURRENT WORK

IMPLEMENTATION SUMMARY

TEST RESULTS

KNOWN ISSUES

TECHNICAL DEBT

IMPORTANT DECISIONS

BLOCKERS

NEXT PHASE

============================================================
STEP 11 — COMPLETION
============================================================

Before marking complete:

- Verify every acceptance criterion.
- Run relevant tests.
- Review security.
- Review UX.
- Review performance.
- Update documentation.
- Update PROJECT_STATUS.md.

Use:

PHASE STATUS:
COMPLETE

or:

PHASE STATUS:
INCOMPLETE

or:

PHASE STATUS:
BLOCKED

Never mark a phase complete when critical work remains.

============================================================
PHASE 0 ===== PRODUCT DISCOVERY & REPOSITORY AUDIT
============================================================

Understand the complete product concept.

The platform connects:

Private asset owners
→ underutilized mobility infrastructure
→ customers who need it.

Initial categories:

- Parking
- EV charging

Inspect the repository completely.

Identify:

- Existing application
- Frontend
- Backend
- Database
- APIs
- Authentication
- Integrations
- Tests
- Documentation
- Deployment
- Configuration

If this is a new project, determine the appropriate starting architecture.

Research and document:

- Product vision
- Customer personas
- Host personas
- Property/society stakeholders
- Platform admins
- Core user journeys
- Supply-side problems
- Demand-side problems
- Trust problems
- Safety problems
- Privacy problems
- Payment problems
- Booking problems
- EV charging problems
- Business model
- Risks
- Assumptions
- Open questions

Create:

docs/product-discovery.md
docs/user-personas.md
docs/core-user-journeys.md
docs/business-model.md
docs/risk-register.md

Do not build major application functionality yet.

Acceptance criteria:

- Product is clearly defined.
- Users are identified.
- Core workflows are documented.
- Major risks are identified.
- Repository is understood.
- Initial architecture direction is documented.

============================================================
PHASE 1 ===== MARKET & COMPETITIVE RESEARCH
============================================================

Perform current market research.

Research:

- Indian parking platforms
- Indian parking apps
- Indian EV charging networks
- Private charger sharing
- Apartment parking solutions
- International peer-to-peer parking
- International peer-to-peer EV charging
- Marketplace pricing
- Trust mechanisms
- Access mechanisms
- Monetization models
- Customer complaints
- Host complaints

Identify:

- Competitor strengths
- Competitor weaknesses
- Missing capabilities
- UX patterns
- Pricing approaches
- Trust mechanisms
- Supply acquisition strategies
- Demand acquisition strategies
- Potential differentiation
- Features not worth copying

Create:

docs/competitive-analysis.md
docs/market-gaps.md
docs/differentiation-strategy.md

Clearly answer:

1. Why would customers use this platform?
2. Why would hosts list their assets?
3. Why would apartment/society owners participate?
4. What could become the product's moat?

Do not implement product functionality.

============================================================
PHASE 2 ===== DOMAIN & MARKETPLACE MODEL
============================================================

Design the core marketplace domain.

Model:

USER
HOST
PROPERTY
ASSET
ASSET TYPE
AVAILABILITY
BOOKING
PAYMENT
PAYOUT
REVIEW
DISPUTE
ACCESS

Parking and EV charging must be asset types.

Define:

- Relationships
- Ownership
- Lifecycle
- State transitions
- Business rules
- Host relationships
- Property relationships
- Booking relationships

Create:

docs/domain-model.md

Acceptance criteria:

- Generic asset architecture exists.
- Parking is an asset type.
- EV charging is an asset type.
- Future asset categories can be added without rewriting the core marketplace.

============================================================
PHASE 3 ===== UX & USER JOURNEY ARCHITECTURE
============================================================

Design UX architecture for:

- Customer
- Host
- Property administrator
- Platform administrator

Customer:

Open
→ Search
→ Discover
→ View
→ Availability
→ Book
→ Pay
→ Access
→ Use
→ Complete
→ Review

Host:

Register
→ Verify
→ Create asset
→ Configure
→ Publish
→ Receive booking
→ Complete
→ Earn

Define:

- Navigation
- Screens
- Empty states
- Loading states
- Error states
- Confirmation states
- Booking states
- Payment states
- Cancellation states

Create:

docs/ux-architecture.md

Do not build the full UI yet.

============================================================
PHASE 4 ===== TRUST, SAFETY & VERIFICATION
============================================================

Design:

- Phone verification
- Email verification
- Identity verification
- Vehicle verification
- Host verification
- Asset verification
- Property verification
- Risk levels
- Fraud detection foundation
- Fake listing prevention
- No-show handling
- Unauthorized access
- Property damage
- Vehicle damage
- Charging damage
- Location privacy

Define information visibility:

Before booking
After booking
During access
After completion

Define dispute lifecycle.

Create:

docs/trust-and-safety.md

Do not integrate expensive external KYC systems unless explicitly required.

============================================================
PHASE 5 ===== TECHNICAL ARCHITECTURE
============================================================

Design production architecture.

Prefer modular monolith.

Modules:

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

Define:

- Frontend
- Backend
- Database
- Cache
- Storage
- Maps
- Payments
- Notifications
- AI
- External integrations

Document:

- Request flow
- Booking flow
- Payment flow
- Notification flow
- AI flow
- Error flow

Create:

docs/architecture.md

============================================================
PHASE 6 ===== DATABASE ARCHITECTURE
============================================================

Design PostgreSQL schema.

Potential entities:

- users
- user_profiles
- vehicles
- hosts
- properties
- property_members
- assets
- parking_details
- charger_details
- asset_photos
- availability_rules
- availability_exceptions
- bookings
- payments
- refunds
- payouts
- reviews
- disputes
- verification
- access_records
- notifications
- audit_logs

Do not blindly create every table.

Define:

- Keys
- Foreign keys
- Constraints
- Indexes
- Statuses
- Timestamps
- Soft deletion
- Audit strategy

Pay special attention to:

- Geographic queries
- Availability
- Booking concurrency
- Payment reconciliation

Create:

docs/database-design.md

============================================================
PHASE 7 ===== PROJECT FOUNDATION
============================================================

Implement the technical foundation.

Establish:

- Frontend
- Backend
- TypeScript/types where appropriate
- Environment configuration
- Database connection
- Migrations
- Validation
- Error handling
- Logging
- API structure
- Authentication foundation
- Testing
- Linting
- Formatting
- Development scripts

Ensure:

- Application starts
- Database connects
- Tests execute
- Environment validation works
- Secrets are protected

Do not build marketplace features yet.

============================================================
PHASE 8 ===== IDENTITY & AUTHORIZATION
============================================================

Implement:

- Registration
- Login
- Logout
- Session/token handling
- User profile
- Roles
- Authorization

Roles:

CUSTOMER
HOST
PROPERTY_ADMIN
PLATFORM_ADMIN

Server-side authorization is mandatory.

Test:

- Authentication
- Invalid credentials
- Expired credentials
- Unauthorized access
- Role access
- Resource ownership

Do not build complete KYC yet.

============================================================
PHASE 9 ===== PROPERTY & ASSET MANAGEMENT
============================================================

Implement generic asset management.

Support:

Property
→ Asset
→ Asset Type

Initial types:

PARKING
EV_CHARGER

Parking information:

- Location
- Photos
- Dimensions
- Vehicle compatibility
- Covered/open
- Security
- CCTV
- Rules
- EV compatibility

EV charger:

- Connector
- AC/DC
- Power
- Charging speed
- Pricing
- Parking
- Access information

Implement:

- Create
- Update
- Publish
- Unpublish
- Archive

Only owners/authorized users may modify assets.

============================================================
PHASE 10 ===== LOCATION & DISCOVERY
============================================================

Implement location-aware discovery.

Customer can:

- Search
- Search nearby
- Filter
- Sort
- Paginate
- View listings

Parking filters:

- Price
- Distance
- Covered
- Security
- EV compatible
- Duration
- Availability

EV filters:

- Connector
- Power
- AC/DC
- Price
- Distance
- Availability

Protect exact residential location where appropriate.

Optimize database queries and indexes.

============================================================
PHASE 11 ===== AVAILABILITY ENGINE
============================================================

Implement generic availability.

Support:

- Availability windows
- Recurring availability
- Exceptions
- Blocks
- Booking-based unavailability

Handle:

- Overlapping bookings
- Adjacent bookings
- Time boundaries
- Time zones
- Blocked periods
- Concurrent access

Availability must come from deterministic application state.

The AI must not determine availability.

============================================================
PHASE 12 ===== BOOKING ENGINE
============================================================

Implement core booking.

Customer:

- Select asset
- Select date
- Select time
- Check availability
- Book
- View booking
- Cancel where supported

Use explicit states.

Protect against:

- Double booking
- Race conditions
- Duplicate requests
- Stale availability

Re-check availability immediately before committing.

Use:

- Transactions
- Constraints
- Locks/concurrency controls
- Idempotency

as appropriate.

Write comprehensive tests.

============================================================
PHASE 13 ===== PARKING EXPERIENCE
============================================================

Build the complete parking experience on top of the generic asset and booking engines.

Implement:

- Parking listing
- Photos
- Parking details
- Rules
- Availability
- Hourly booking
- Daily booking
- Overnight booking
- Monthly booking architecture
- Recurring booking architecture

Customer:

Search
→ Select
→ Check
→ Book

Host:

Create
→ Publish
→ Receive
→ Manage

Do not implement unrelated future functionality.

============================================================
PHASE 14 ===== EV CHARGING EXPERIENCE
============================================================

Build EV charging on top of generic asset/booking infrastructure.

Implement:

- Charger details
- Connector compatibility
- Power
- AC/DC
- Pricing
- Availability
- Charging session model
- Parking + charging relationship

Do not assume live hardware.

Create clean integration interfaces for future smart chargers.

============================================================
PHASE 15 ===== PAYMENTS
============================================================

Integrate selected payment provider.

Implement:

- Payment initiation
- Confirmation
- Webhooks
- Signature verification
- Idempotency
- Payment states
- Failed payments
- Refund architecture
- Reconciliation

Never trust frontend payment success.

Test:

- Successful payment
- Failed payment
- Duplicate webhook
- Delayed webhook
- Refund
- Payment mismatch

============================================================
PHASE 16 ===== HOST EARNINGS & PAYOUTS
============================================================

Implement marketplace financial logic.

Separate:

Customer payment
Platform commission
Fees/taxes where applicable
Host earnings
Payout

Host can view:

- Gross
- Fees
- Commission
- Net
- Pending
- Completed

Build financial ledger/reconciliation foundations.

Do not prematurely build complex banking infrastructure.

============================================================
PHASE 17 ===== ACCESS MANAGEMENT
============================================================

Implement access abstraction.

Initial mechanisms may include:

- OTP
- QR
- Digital pass
- Vehicle number
- Security verification

Design interfaces for:

- Smart locks
- ANPR
- Gate systems
- Society systems

Access must require valid booking/authorization.

Log access events.

Protect access information.

============================================================
PHASE 18 ===== NOTIFICATIONS
============================================================

Implement notification architecture.

Events:

- Booking confirmation
- Reminder
- Start
- End
- Charging start
- Charging completion
- Cancellation
- Refund
- Payment
- Payout
- Dispute
- Verification

Providers:

- Push
- Email
- SMS
- WhatsApp

Use provider abstraction.

Implement retries.

Prevent duplicates.

Track delivery status.

============================================================
PHASE 19 ===== REVIEWS, TRUST & DISPUTES
============================================================

Implement:

- Customer reviews
- Host reviews
- Ratings
- Trust signals
- Disputes
- Evidence
- Dispute states
- Admin resolution
- Audit logs

Handle:

- Unavailable asset
- Incorrect listing
- Access failure
- Damage
- Charging failure
- Billing dispute
- No-show
- Cancellation
- Misconduct

Do not allow AI to automatically resolve high-risk disputes.

============================================================
PHASE 20 ===== ADMIN PLATFORM
============================================================

Build platform administration.

Admin management:

- Users
- Hosts
- Properties
- Assets
- Bookings
- Payments
- Payouts
- Reviews
- Disputes
- Verification
- Fraud indicators
- Configuration

Include:

- Search
- Filters
- Pagination
- Detail views
- Audit logs

Every admin action requires authorization.

============================================================
PHASE 21 ===== ANALYTICS & MARKETPLACE INTELLIGENCE
============================================================

Track:

SUPPLY

- Hosts
- Assets
- Parking inventory
- Charger inventory
- Availability
- Utilization

DEMAND

- Customers
- Searches
- Conversion
- Repeat bookings

MARKETPLACE

- GMV
- Revenue
- Commission
- Average booking value
- Cancellation
- No-show
- Utilization
- Retention

Focus on liquidity.

Create:

docs/analytics.md

============================================================
PHASE 22 ===== AI LAYER
============================================================

Now introduce AI.

Prioritize actual user problems.

Potential capabilities:

1. Natural-language parking search
2. Natural-language EV search
3. Recommendations
4. AI parking assistant
5. AI EV assistant
6. Host assistant
7. Revenue insights
8. Demand forecasting
9. Intelligent support
10. Natural-language analytics

Architecture:

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

AI must never directly mutate critical marketplace state.

AI must never hallucinate:

- Availability
- Price
- Booking
- Payment
- Payout
- Authorization
- Access

Create:

docs/ai-strategy.md

Track:

- Model
- Cost
- Latencies
- Errors
- Tool calls
- Evaluation
- Fallback

============================================================
PHASE 23 ===== PRODUCTION HARDENING & LAUNCH
============================================================

Perform a complete production audit.

SECURITY

Review:

- Authentication
- Authorization
- Secrets
- PII
- Location privacy
- Payment security
- Webhooks
- Rate limiting
- Abuse
- Injection
- Data access

RELIABILITY

Review:

- Booking concurrency
- Payment failure
- Webhook retries
- Notification failure
- Database failure
- External service failure
- AI failure

PERFORMANCE

Review:

- Database queries
- Indexes
- API latency
- Search
- Maps
- Booking
- Caching opportunities

UX

Review:

- Onboarding
- Discovery
- Listing
- Booking
- Payment
- Access
- Host management
- Earnings
- Errors
- Recovery

TESTING

Run:

- Unit
- Integration
- API
- E2E
- Security
- Concurrency
- Payment
- Critical workflows

OBSERVABILITY

Verify:

- Logs
- Metrics
- Error tracking
- Health checks
- Alerts
- Payment monitoring
- Booking monitoring
- AI monitoring

Create:

docs/production-readiness.md
docs/launch-checklist.md
docs/final-qa.md

Run the complete test suite.

Fix critical issues.

Do not perform unnecessary architectural rewrites.

Prepare a pilot launch plan.

Recommended pilot:

ONE CITY
 ↓
LIMITED NEIGHBORHOODS
 ↓
LIMITED HOSTS
 ↓
LIMITED ASSETS
 ↓
CONTROLLED CUSTOMERS
 ↓
MEASURE
 ↓
LEARN
 ↓
IMPROVE
 ↓
EXPAND

Final report must contain:

1. Production-ready functionality
2. Non-production-ready functionality
3. Known risks
4. Technical debt
5. Operational requirements
6. Monitoring requirements
7. Pilot recommendation
8. Next priorities

============================================================
FINAL EXECUTION RULE
============================================================

After every phase:

- Test
- Review
- Document
- Update PROJECT_STATUS.md
- Verify acceptance criteria
- Mark phase status

Do not skip unresolved critical issues.

When the user says:

"Continue"

identify the next incomplete phase and execute it.

When the user says:

"Review"

review the current phase and implementation without unnecessarily starting the next phase.

When the user says:

"Audit"

perform a deeper review of the current implementation against CLAUDE.md, previous decisions and the current phase.

When the user says:

"Continue to next phase"

complete the current phase if necessary, then move to the next incomplete phase.

END OF PHASES.md