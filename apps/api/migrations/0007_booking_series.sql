-- 0007 booking series: monthly arrangements as a series of ordinary bookings on one unit (D-014, domain-model §3.4,
-- §5.4, BR-13). Each period is a normal booking, so availability, payment, access and ledger need no special cases.
-- `cadence` is the recurrence seam: only MONTHLY is built for the pilot (weekday patterns fit the same shape later).

CREATE TABLE booking.booking_series (
  id                    uuid PRIMARY KEY,
  customer_id           uuid NOT NULL REFERENCES identity.users (id),
  vehicle_id            uuid NOT NULL REFERENCES users.vehicles (id),
  asset_id              uuid NOT NULL REFERENCES assets.assets (id),
  unit_id               uuid NOT NULL REFERENCES assets.asset_units (id),   -- the same unit for every period
  host_account_id       uuid NOT NULL REFERENCES identity.host_accounts (id),
  property_id           uuid NOT NULL REFERENCES properties.properties (id),
  cadence               text NOT NULL CHECK (cadence IN ('MONTHLY')),
  anchor_start          timestamptz NOT NULL,                              -- period 1 start; later periods keep its day
  timezone              text NOT NULL,                                     -- property timezone at creation
  status                text NOT NULL CHECK (status IN ('REQUESTED', 'ACTIVE', 'PAST_DUE', 'NOTICE_GIVEN', 'ENDED')),
  period_price_snapshot jsonb NOT NULL,                                    -- price per period, fixed for the arrangement
  period_total_paise    bigint NOT NULL CHECK (period_total_paise >= 0),
  policy_snapshot       jsonb NOT NULL,
  notice_days           integer NOT NULL DEFAULT 15 CHECK (notice_days BETWEEN 0 AND 90),
  grace_days            integer NOT NULL DEFAULT 3 CHECK (grace_days BETWEEN 0 AND 14),
  notice_given_at       timestamptz,
  notice_by             text CHECK (notice_by IN ('CUSTOMER', 'HOST', 'PLATFORM')),
  ends_at               timestamptz,                                       -- a period boundary once notice is given
  ended_reason          text CHECK (ended_reason IN ('NOT_CONFIRMED', 'NOTICE', 'RENEWAL_UNPAID', 'UNIT_UNAVAILABLE',
                          'HOST_CANCELLED', 'CUSTOMER_CANCELLED', 'PLATFORM')),
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((notice_given_at IS NULL) = (notice_by IS NULL)),
  CHECK (status <> 'NOTICE_GIVEN' OR ends_at IS NOT NULL),
  CHECK ((status = 'ENDED') = (ended_reason IS NOT NULL))
);
CREATE INDEX booking_series_customer_ix ON booking.booking_series (customer_id, created_at DESC);
CREATE INDEX booking_series_host_ix ON booking.booking_series (host_account_id, created_at DESC);
CREATE INDEX booking_series_open_ix ON booking.booking_series (status) WHERE status <> 'ENDED';
CREATE TRIGGER booking_series_touch BEFORE UPDATE ON booking.booking_series
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE booking.series_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id   uuid NOT NULL REFERENCES booking.booking_series (id),
  from_status text,
  to_status   text NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('CUSTOMER', 'HOST', 'PLATFORM_ADMIN', 'SYSTEM')),
  actor_id    uuid,
  reason      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX series_events_series_ix ON booking.series_events (series_id, created_at);
CREATE TRIGGER series_events_append_only BEFORE UPDATE OR DELETE ON booking.series_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- Periods. Renewal periods (n > 1) are created by the system, not from a customer quote.
ALTER TABLE booking.bookings
  ADD COLUMN series_id uuid REFERENCES booking.booking_series (id),
  ADD COLUMN period_index integer CHECK (period_index >= 1),
  ALTER COLUMN quote_id DROP NOT NULL,
  ADD CONSTRAINT bookings_series_period_ck CHECK ((series_id IS NULL) = (period_index IS NULL)),
  ADD CONSTRAINT bookings_quote_ck CHECK (quote_id IS NOT NULL OR period_index > 1),
  ADD CONSTRAINT bookings_series_period_uq UNIQUE (series_id, period_index);
