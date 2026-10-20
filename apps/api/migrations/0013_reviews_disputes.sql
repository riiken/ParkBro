-- 0013 reviews and disputes (Phase 19; domain-model §3.7, §5.10, §5.11; trust-and-safety §8–9; D-148..).
CREATE SCHEMA reviews;
CREATE SCHEMA disputes;

-- Two-sided, blind reviews (§5.10): SUBMITTED reviews stay hidden until both sides submit or the window closes.
CREATE TABLE reviews.reviews (
  id            uuid PRIMARY KEY,
  booking_id    uuid NOT NULL REFERENCES booking.bookings (id),
  author_kind   text NOT NULL CHECK (author_kind IN ('CUSTOMER', 'HOST')),
  author_id     uuid NOT NULL REFERENCES identity.users (id),
  asset_id      uuid NOT NULL REFERENCES assets.assets (id),
  host_account_id uuid NOT NULL REFERENCES identity.host_accounts (id),
  customer_id   uuid NOT NULL REFERENCES identity.users (id),
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  dimensions    jsonb NOT NULL DEFAULT '{}',       -- accuracy, communication, cleanliness, safety, access, reliability (1–5)
  body          text CHECK (char_length(body) <= 1000),
  status        text NOT NULL CHECK (status IN ('SUBMITTED', 'PUBLISHED', 'REMOVED')),
  removed_reason text,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, author_kind),
  CHECK ((status = 'REMOVED') = (removed_reason IS NOT NULL))
);
CREATE INDEX reviews_asset_ix ON reviews.reviews (asset_id, published_at DESC) WHERE status = 'PUBLISHED' AND author_kind = 'CUSTOMER';
CREATE INDEX reviews_customer_ix ON reviews.reviews (customer_id) WHERE status = 'PUBLISHED' AND author_kind = 'HOST';
CREATE INDEX reviews_pending_ix ON reviews.reviews (created_at) WHERE status = 'SUBMITTED';
CREATE TRIGGER reviews_touch BEFORE UPDATE ON reviews.reviews FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- Disputes (§5.11): first-class, with evidence and a timeline; high-risk ones are resolved only by trust & safety.
CREATE TABLE disputes.disputes (
  id              uuid PRIMARY KEY,
  booking_id      uuid NOT NULL REFERENCES booking.bookings (id),
  opened_by_kind  text NOT NULL CHECK (opened_by_kind IN ('CUSTOMER', 'HOST')),
  opened_by       uuid NOT NULL REFERENCES identity.users (id),
  customer_id     uuid NOT NULL REFERENCES identity.users (id),
  host_account_id uuid NOT NULL REFERENCES identity.host_accounts (id),
  category        text NOT NULL CHECK (category IN ('UNAVAILABLE_ASSET', 'INCORRECT_LISTING', 'ACCESS_FAILURE', 'DAMAGE',
                    'CHARGING_FAILURE', 'BILLING', 'NO_SHOW', 'CANCELLATION', 'MISCONDUCT')),
  risk            text NOT NULL CHECK (risk IN ('LOW', 'HIGH')),
  requested_outcome text NOT NULL CHECK (requested_outcome IN ('REFUND', 'PARTIAL_REFUND', 'COMPENSATION', 'REVIEW_ONLY', 'OTHER')),
  status          text NOT NULL CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'AWAITING_INFO', 'ESCALATED', 'RESOLVED', 'CLOSED')),
  outcome         text CHECK (outcome IN ('NO_ACTION', 'REFUND_FULL', 'REFUND_PARTIAL', 'WARNING', 'RESTRICT_ACCOUNT')),
  refund_paise    bigint CHECK (refund_paise >= 0),
  resolution_note text CHECK (char_length(resolution_note) <= 2000),
  resolved_by     uuid REFERENCES identity.users (id),
  resolved_at     timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('RESOLVED', 'CLOSED')) = (outcome IS NOT NULL))
);
CREATE UNIQUE INDEX disputes_open_per_party_uq ON disputes.disputes (booking_id, opened_by_kind) WHERE status NOT IN ('RESOLVED', 'CLOSED');
CREATE INDEX disputes_queue_ix ON disputes.disputes (risk, created_at) WHERE status NOT IN ('RESOLVED', 'CLOSED');
CREATE TRIGGER disputes_touch BEFORE UPDATE ON disputes.disputes FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE disputes.dispute_messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id  uuid NOT NULL REFERENCES disputes.disputes (id),
  author_kind text NOT NULL CHECK (author_kind IN ('CUSTOMER', 'HOST', 'ADMIN', 'SYSTEM')),
  author_id   uuid REFERENCES identity.users (id),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  internal    boolean NOT NULL DEFAULT false,              -- admin-only notes
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_messages_ix ON disputes.dispute_messages (dispute_id, id);
CREATE TRIGGER dispute_messages_append_only BEFORE UPDATE OR DELETE ON disputes.dispute_messages
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

CREATE TABLE disputes.dispute_evidence (
  id           uuid PRIMARY KEY,
  dispute_id   uuid NOT NULL REFERENCES disputes.disputes (id),
  uploaded_by_kind text NOT NULL CHECK (uploaded_by_kind IN ('CUSTOMER', 'HOST', 'ADMIN')),
  uploaded_by  uuid NOT NULL REFERENCES identity.users (id),
  storage_key  text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/webp')),
  width        integer NOT NULL,
  height       integer NOT NULL,
  byte_size    integer NOT NULL,
  sha256       bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_evidence_ix ON disputes.dispute_evidence (dispute_id, created_at);

-- Dispute refunds go through the normal refund pipeline (ledger, provider, notifications).
ALTER TABLE payments.refunds DROP CONSTRAINT refunds_reason_check;
ALTER TABLE payments.refunds ADD CONSTRAINT refunds_reason_check CHECK (reason IN ('CUSTOMER_CANCELLED', 'HOST_CANCELLED',
  'PLATFORM_CANCELLED', 'LATE_PAYMENT_UNAVAILABLE', 'DUPLICATE_PAYMENT', 'SERIES_ENDED', 'DISPUTE'));
