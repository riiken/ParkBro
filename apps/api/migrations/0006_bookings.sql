-- 0006 bookings: vehicles, short-lived quotes, bookings (double-booking guard validated in the Phase 6 prototype),
-- and append-only booking history.
-- Design: docs/domain-model.md §3.4, §5.3, BR-07..BR-22; docs/database-design.md §3, §6 (D-040..D-042).

-- ------------------------------------------------------------------ vehicles
CREATE SCHEMA users;

CREATE TABLE users.vehicles (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL REFERENCES identity.users (id),
  plate_enc     bytea NOT NULL,                 -- field cipher (personal data under DPDP)
  plate_hmac    bytea NOT NULL,                 -- blind index (uniqueness, later guard lookup)
  plate_last4   text NOT NULL CHECK (plate_last4 ~ '^[A-Z0-9]{4}$'),
  vehicle_class text NOT NULL CHECK (vehicle_class IN ('HATCHBACK', 'SEDAN', 'SUV', 'MUV')),
  is_ev         boolean NOT NULL DEFAULT false,
  connectors    text[] NOT NULL DEFAULT '{}' CHECK (connectors <@
                  ARRAY['TYPE2', 'CCS2', 'BHARAT_AC001', 'BHARAT_DC001', 'IEC_15A', 'GBT']::text[]),
  nickname      text CHECK (char_length(nickname) <= 30),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REMOVED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (is_ev OR cardinality(connectors) = 0)
);
CREATE UNIQUE INDEX vehicles_active_plate_uq ON users.vehicles (plate_hmac) WHERE status = 'ACTIVE';
CREATE INDEX vehicles_owner_ix ON users.vehicles (owner_id) WHERE status = 'ACTIVE';

-- ------------------------------------------------------------------ quotes (BR-11: charge exactly what was shown)
CREATE TABLE pricing.quotes (
  id              uuid PRIMARY KEY,
  customer_id     uuid NOT NULL REFERENCES identity.users (id),
  asset_id        uuid NOT NULL REFERENCES assets.assets (id),
  mode            text NOT NULL CHECK (mode IN ('HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION')),
  period          tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  lines           jsonb NOT NULL,
  total_paise     bigint NOT NULL CHECK (total_paise >= 0),
  config_version  text NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_customer_ix ON pricing.quotes (customer_id, created_at);
CREATE INDEX quotes_expiry_ix ON pricing.quotes (expires_at);

-- ------------------------------------------------------------------ bookings
CREATE SCHEMA booking;

CREATE TABLE booking.bookings (
  id                  uuid PRIMARY KEY,
  customer_id         uuid NOT NULL REFERENCES identity.users (id),
  vehicle_id          uuid NOT NULL REFERENCES users.vehicles (id),
  asset_id            uuid NOT NULL REFERENCES assets.assets (id),
  unit_id             uuid NOT NULL REFERENCES assets.asset_units (id),
  host_account_id     uuid NOT NULL REFERENCES identity.host_accounts (id),
  property_id         uuid NOT NULL REFERENCES properties.properties (id),
  asset_type          text NOT NULL CHECK (asset_type IN ('PARKING', 'EV_CHARGING')),
  mode                text NOT NULL CHECK (mode IN ('HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION')),
  period              tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  buffer_minutes      integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),   -- snapshot
  blocked_period      tstzrange NOT NULL,                                                     -- set by trigger
  status              text NOT NULL CHECK (status IN ('AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED',
                        'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'DECLINED', 'NO_SHOW')),
  holds_unit          boolean GENERATED ALWAYS AS
                        (status IN ('AWAITING_HOST_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS')) STORED,
  hold_expires_at     timestamptz,
  approval_expires_at timestamptz,
  quote_id            uuid NOT NULL REFERENCES pricing.quotes (id),
  price_snapshot      jsonb NOT NULL,       -- lines + totals + config version (BR-16, BR-17)
  policy_snapshot     jsonb NOT NULL,       -- cancellation policy as agreed (BR-22)
  total_paise         bigint NOT NULL CHECK (total_paise >= 0),
  idempotency_key     text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  cancelled_by        text CHECK (cancelled_by IN ('CUSTOMER', 'HOST', 'PLATFORM')),
  cancel_reason       text CHECK (char_length(cancel_reason) <= 300),
  refund_paise        bigint CHECK (refund_paise >= 0),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'PENDING_PAYMENT' OR hold_expires_at IS NOT NULL),
  CHECK (status <> 'AWAITING_HOST_APPROVAL' OR approval_expires_at IS NOT NULL),
  CHECK ((status = 'CANCELLED') = (cancelled_by IS NOT NULL)),
  UNIQUE (customer_id, idempotency_key),
  UNIQUE (quote_id),
  -- BR-08: two holding bookings of one unit never overlap, including the buffer after each.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (unit_id WITH =, blocked_period WITH &&) WHERE (holds_unit)
);
CREATE INDEX bookings_customer_ix ON booking.bookings (customer_id, lower(period) DESC);
CREATE INDEX bookings_host_ix ON booking.bookings (host_account_id, lower(period));
CREATE INDEX bookings_asset_ix ON booking.bookings (asset_id, lower(period));
CREATE INDEX bookings_property_period_gix ON booking.bookings USING gist (property_id, blocked_period) WHERE holds_unit;
CREATE INDEX bookings_lapsed_holds_ix ON booking.bookings (hold_expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX bookings_lapsed_approvals_ix ON booking.bookings (approval_expires_at) WHERE status = 'AWAITING_HOST_APPROVAL';
CREATE INDEX bookings_due_ix ON booking.bookings (upper(period)) WHERE status IN ('CONFIRMED', 'IN_PROGRESS');

CREATE FUNCTION booking.set_blocked_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Generated columns can't do this: timestamptz + interval is not IMMUTABLE (Phase 6 finding, D-040).
  NEW.blocked_period := tstzrange(lower(NEW.period), upper(NEW.period) + make_interval(mins => NEW.buffer_minutes), '[)');
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_blocked_period BEFORE INSERT OR UPDATE OF period, buffer_minutes ON booking.bookings
  FOR EACH ROW EXECUTE FUNCTION booking.set_blocked_period();
CREATE TRIGGER bookings_touch BEFORE UPDATE ON booking.bookings FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE booking.booking_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES booking.bookings (id),
  from_status text,
  to_status   text NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('CUSTOMER', 'HOST', 'PROPERTY_ADMIN', 'PLATFORM_ADMIN', 'SYSTEM')),
  actor_id    uuid,
  reason      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_booking_ix ON booking.booking_events (booking_id, created_at);
CREATE TRIGGER booking_events_append_only BEFORE UPDATE OR DELETE ON booking.booking_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
