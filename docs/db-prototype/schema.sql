-- Phase 6 design prototype: the concurrency- and money-critical core of the schema.
-- Purpose: prove the constraints described in docs/database-design.md against a real PostgreSQL + PostGIS.
-- This is NOT an application migration. Phase 7 creates real migrations from database-design.md.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA identity; CREATE SCHEMA properties; CREATE SCHEMA assets;
CREATE SCHEMA booking;  CREATE SCHEMA payments;   CREATE SCHEMA ledger; CREATE SCHEMA platform; CREATE SCHEMA users;

-- updated_at helper
CREATE FUNCTION platform.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------- identity (minimal)
CREATE TABLE identity.users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_enc   bytea NOT NULL,
  phone_hmac  bytea NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users.vehicles (plate uniqueness among active vehicles)
CREATE TABLE users.vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES identity.users(id),
  plate_enc     bytea NOT NULL,
  plate_hmac    bytea NOT NULL,
  vehicle_class text NOT NULL CHECK (vehicle_class IN ('HATCHBACK','SEDAN','SUV','MUV')),
  is_ev         boolean NOT NULL DEFAULT false,
  connectors    text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vehicles_active_plate_uq ON users.vehicles (plate_hmac) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------- properties
CREATE TABLE properties.properties (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('APARTMENT_SOCIETY','INDEPENDENT_HOUSE','COMMERCIAL','OFFICE','OTHER')),
  exact_address_enc    bytea NOT NULL,
  exact_point_enc      bytea NOT NULL,                      -- encrypted; never queried in SQL
  public_point         geography(Point, 4326) NOT NULL,     -- fuzzed, stable (L-1)
  area_label           text NOT NULL,
  timezone             text NOT NULL DEFAULT 'Asia/Kolkata',
  participation_status text NOT NULL CHECK (participation_status IN
                         ('NOT_REQUIRED','CONSENT_REQUIRED','PENDING_CONSENT','PARTICIPATING','SUSPENDED','WITHDRAWN')),
  outsider_cap         integer CHECK (outsider_cap IS NULL OR outsider_cap > 0),  -- from current policy version
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX properties_public_point_gix ON properties.properties USING gist (public_point);

-- ---------------------------------------------------------------- assets
CREATE TABLE assets.assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties.properties(id),
  asset_type     text NOT NULL CHECK (asset_type IN ('PARKING','EV_CHARGING')),
  status         text NOT NULL CHECK (status IN ('DRAFT','PENDING_REVIEW','PUBLISHED','PAUSED','SUSPENDED','ARCHIVED')),
  buffer_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assets.asset_units (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id  uuid NOT NULL REFERENCES assets.assets(id),
  label     text NOT NULL,
  status    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE (asset_id, label)
);

-- ---------------------------------------------------------------- booking
CREATE TABLE booking.bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES identity.users(id),
  asset_id         uuid NOT NULL REFERENCES assets.assets(id),
  unit_id          uuid NOT NULL REFERENCES assets.asset_units(id),
  property_id      uuid NOT NULL REFERENCES properties.properties(id),
  mode             text NOT NULL CHECK (mode IN ('HOURLY','DAILY','OVERNIGHT','MONTHLY','CHARGING_SESSION')),
  period           tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  buffer_minutes   integer NOT NULL DEFAULT 0,            -- snapshot of asset buffer at commit
  -- [start, end + buffer): set by trigger. A generated column is not possible because
  -- timestamptz + interval is not IMMUTABLE (finding from the Phase 6 validation run).
  blocked_period   tstzrange NOT NULL,
  status           text NOT NULL CHECK (status IN ('AWAITING_HOST_APPROVAL','PENDING_PAYMENT','CONFIRMED','IN_PROGRESS',
                                                   'COMPLETED','CANCELLED','EXPIRED','DECLINED','NO_SHOW')),
  holds_unit       boolean GENERATED ALWAYS AS
                     (status IN ('AWAITING_HOST_APPROVAL','PENDING_PAYMENT','CONFIRMED','IN_PROGRESS')) STORED,
  hold_expires_at  timestamptz,
  total_paise      bigint NOT NULL CHECK (total_paise >= 0),
  idempotency_key  text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'PENDING_PAYMENT' OR hold_expires_at IS NOT NULL),
  UNIQUE (customer_id, idempotency_key),
  -- BR-08: the last line of defence against double booking
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (unit_id WITH =, blocked_period WITH &&) WHERE (holds_unit)
);
CREATE INDEX bookings_property_period_gix ON booking.bookings USING gist (property_id, blocked_period) WHERE holds_unit;
CREATE INDEX bookings_lapsed_holds_ix ON booking.bookings (hold_expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE TRIGGER bookings_touch BEFORE UPDATE ON booking.bookings FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
CREATE FUNCTION booking.set_blocked_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.blocked_period := tstzrange(lower(NEW.period), upper(NEW.period) + make_interval(mins => NEW.buffer_minutes), '[)');
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_blocked_period BEFORE INSERT OR UPDATE OF period, buffer_minutes ON booking.bookings
  FOR EACH ROW EXECUTE FUNCTION booking.set_blocked_period();

-- Transition history (append-only)
CREATE TABLE booking.booking_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES booking.bookings(id),
  from_status text, to_status text NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('CUSTOMER','HOST','PROPERTY_ADMIN','PLATFORM_ADMIN','SYSTEM')),
  actor_id    uuid, reason text, request_id text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- BR-06: maximum number of simultaneously holding bookings in a property over [s, e) (sweep over start points)
CREATE FUNCTION booking.max_concurrent_in_property(p_property uuid, p_period tstzrange)
RETURNS integer LANGUAGE sql STABLE AS $$
  WITH overlapping AS (
    SELECT blocked_period FROM booking.bookings
    WHERE property_id = p_property AND holds_unit AND blocked_period && p_period
      AND NOT (status = 'PENDING_PAYMENT' AND hold_expires_at < now())
  ), points AS (
    SELECT lower(p_period) AS t
    UNION SELECT greatest(lower(blocked_period), lower(p_period)) FROM overlapping
  )
  SELECT coalesce(max(c), 0)::int FROM (
    SELECT (SELECT count(*) FROM overlapping o WHERE o.blocked_period @> p.t) AS c FROM points p
  ) x
$$;

-- ---------------------------------------------------------------- payments (dedupe)
CREATE TABLE payments.provider_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider    text NOT NULL,
  event_id    text NOT NULL,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------- ledger (double entry, balanced journals, append-only)
CREATE TABLE ledger.accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,              -- e.g. host_payable_pending
  owner_kind text NOT NULL CHECK (owner_kind IN ('PLATFORM','HOST','PROPERTY','CUSTOMER')),
  owner_id   uuid,
  UNIQUE (code, owner_kind, owner_id)
);
CREATE TABLE ledger.journals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL,
  booking_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ledger.entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id  uuid NOT NULL REFERENCES ledger.journals(id),
  account_id  uuid NOT NULL REFERENCES ledger.accounts(id),
  direction   text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entries_account_ix ON ledger.entries (account_id, created_at);

CREATE FUNCTION ledger.assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT coalesce(sum(amount_paise) FILTER (WHERE direction='DEBIT'),0),
         coalesce(sum(amount_paise) FILTER (WHERE direction='CREDIT'),0)
    INTO d, c FROM ledger.entries WHERE journal_id = NEW.journal_id;
  IF d <> c THEN RAISE EXCEPTION 'ledger journal % unbalanced: debit % credit %', NEW.journal_id, d, c; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_balanced();

CREATE FUNCTION platform.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME; END $$;
CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON ledger.entries
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
CREATE TRIGGER booking_events_append_only BEFORE UPDATE OR DELETE ON booking.booking_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
