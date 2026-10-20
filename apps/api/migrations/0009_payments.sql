-- 0009 payments (Phase 15; domain-model §5.5, BR-15; database-design §3, §8; D-120..). Payment state is authoritative
-- backend state: SUCCEEDED is set only from a signature-verified provider webhook or a server-side status query,
-- never from the client (CLAUDE.md §15). The ledger (double entry) arrives with host earnings in Phase 16.
CREATE SCHEMA payments;

CREATE TABLE payments.payments (
  id                  uuid PRIMARY KEY,
  booking_id          uuid NOT NULL REFERENCES booking.bookings (id),
  customer_id         uuid NOT NULL REFERENCES identity.users (id),
  provider            text NOT NULL CHECK (provider IN ('FAKE', 'RAZORPAY')),
  provider_order_id   text NOT NULL,
  provider_payment_id text,
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status              text NOT NULL CHECK (status IN ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  method              text CHECK (char_length(method) <= 40),
  failure_code        text CHECK (char_length(failure_code) <= 100),
  failure_reason      text CHECK (char_length(failure_reason) <= 300),
  mismatch            boolean NOT NULL DEFAULT false,      -- provider amount/order differed: quarantined, never confirms
  idempotency_key     text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  succeeded_at        timestamptz,
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id),
  UNIQUE (customer_id, idempotency_key),
  CHECK ((status = 'SUCCEEDED') = (succeeded_at IS NOT NULL))
);
CREATE UNIQUE INDEX payments_provider_payment_uq ON payments.payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_booking_ix ON payments.payments (booking_id, created_at);
CREATE INDEX payments_open_ix ON payments.payments (status, created_at) WHERE status IN ('CREATED', 'PENDING');
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments.payments FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE payments.payment_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id  uuid NOT NULL REFERENCES payments.payments (id),
  from_status text,
  to_status   text NOT NULL,
  source      text NOT NULL CHECK (source IN ('CUSTOMER', 'WEBHOOK', 'PROVIDER_QUERY', 'SYSTEM')),
  detail      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_payment_ix ON payments.payment_events (payment_id, created_at);
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payments.payment_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

CREATE TABLE payments.refunds (
  id                 uuid PRIMARY KEY,
  payment_id         uuid NOT NULL REFERENCES payments.payments (id),
  booking_id         uuid NOT NULL REFERENCES booking.bookings (id),
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  reason             text NOT NULL CHECK (reason IN ('CUSTOMER_CANCELLED', 'HOST_CANCELLED', 'PLATFORM_CANCELLED',
                       'LATE_PAYMENT_UNAVAILABLE', 'DUPLICATE_PAYMENT', 'SERIES_ENDED')),
  status             text NOT NULL CHECK (status IN ('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED')),
  provider_refund_id text,
  failure_reason     text CHECK (char_length(failure_reason) <= 300),
  attempts           integer NOT NULL DEFAULT 0,
  idempotency_key    text NOT NULL UNIQUE,                 -- e.g. booking:<id>:cancel — one refund per cause
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('SUBMITTED', 'SUCCEEDED') OR provider_refund_id IS NOT NULL)
);
CREATE UNIQUE INDEX refunds_provider_uq ON payments.refunds (provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX refunds_open_ix ON payments.refunds (status, created_at) WHERE status IN ('PENDING', 'SUBMITTED');
CREATE TRIGGER refunds_touch BEFORE UPDATE ON payments.refunds FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- Refunded total never exceeds the captured amount (callers also lock the payment row first).
CREATE FUNCTION payments.check_refund_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured bigint; refunded bigint;
BEGIN
  SELECT amount_paise INTO captured FROM payments.payments WHERE id = NEW.payment_id AND status = 'SUCCEEDED';
  IF captured IS NULL THEN RAISE EXCEPTION 'refund for a payment that did not succeed' USING ERRCODE = 'check_violation'; END IF;
  SELECT coalesce(sum(amount_paise), 0) INTO refunded FROM payments.refunds
    WHERE payment_id = NEW.payment_id AND status <> 'FAILED' AND id <> NEW.id;
  IF refunded + NEW.amount_paise > captured THEN
    RAISE EXCEPTION 'refunds exceed captured amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_total BEFORE INSERT OR UPDATE OF amount_paise, status ON payments.refunds
  FOR EACH ROW WHEN (NEW.status <> 'FAILED') EXECUTE FUNCTION payments.check_refund_total();

-- Raw provider webhooks, deduplicated (C11). Only signature-valid events are stored.
CREATE TABLE payments.provider_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider           text NOT NULL,
  event_id           text NOT NULL,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz,                          -- processing lease (concurrent deliveries)
  processed_at       timestamptz,
  quarantined_reason text,
  UNIQUE (provider, event_id)
);

CREATE TABLE payments.settlement_lines (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            text NOT NULL,
  settlement_id       text NOT NULL,
  entity_kind         text NOT NULL CHECK (entity_kind IN ('PAYMENT', 'REFUND', 'ADJUSTMENT')),
  provider_entity_id  text NOT NULL,
  amount_paise        bigint NOT NULL,
  fee_paise           bigint NOT NULL DEFAULT 0,
  tax_paise           bigint NOT NULL DEFAULT 0,
  settled_at          timestamptz NOT NULL,
  imported_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, settlement_id, provider_entity_id)
);

CREATE TABLE payments.reconciliation_items (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('AMOUNT_MISMATCH', 'UNKNOWN_PAYMENT', 'UNSETTLED_PAYMENT', 'SETTLEMENT_MISMATCH',
                'STUCK_CONFIRMATION', 'REFUND_FAILED')),
  refs        jsonb NOT NULL,
  dedupe_key  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  note        text,
  resolved_by uuid REFERENCES identity.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX reconciliation_open_ix ON payments.reconciliation_items (created_at) WHERE status = 'OPEN';
