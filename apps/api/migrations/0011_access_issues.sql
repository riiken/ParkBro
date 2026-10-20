-- 0011 access (Phase 17; domain-model §3.6, §5.7, §5.8, BR-24..BR-26; trust-and-safety §10; D-136..) and booking
-- issues (recourse). Access always derives from a valid booking; every lookup and entry is logged.
CREATE SCHEMA access;

-- Per-gate guard links (G-01). Only the hash of the token is stored; the link is shown once.
CREATE TABLE access.gate_tokens (
  id          uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES properties.properties (id),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  token_hash  bytea NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  expires_at  timestamptz NOT NULL,                     -- 90 days, renew by creating a new link
  created_by  uuid NOT NULL REFERENCES identity.users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_tokens_property_ix ON access.gate_tokens (property_id) WHERE status = 'ACTIVE';

-- One grant per confirmed booking (each monthly period is its own booking, so its own grant).
CREATE TABLE access.access_grants (
  id          uuid PRIMARY KEY,
  booking_id  uuid NOT NULL UNIQUE REFERENCES booking.bookings (id),
  property_id uuid NOT NULL REFERENCES properties.properties (id),
  asset_id    uuid NOT NULL REFERENCES assets.assets (id),
  unit_id     uuid NOT NULL REFERENCES assets.asset_units (id),
  customer_id uuid NOT NULL REFERENCES identity.users (id),
  vehicle_id  uuid NOT NULL REFERENCES users.vehicles (id),
  plate_hmac  bytea NOT NULL,                            -- vehicle-number verification (blind index)
  plate_last4 text NOT NULL,
  code_hmac   bytea NOT NULL,                            -- 6-digit code lookup (blind index, scoped by property)
  code_enc    bytea NOT NULL,                            -- shown to the customer (field cipher)
  valid_from  timestamptz NOT NULL,                      -- start − early grace
  valid_until timestamptz NOT NULL,                      -- end + late grace
  status      text NOT NULL CHECK (status IN ('ISSUED', 'USED', 'REVOKED')),  -- ACTIVE/EXPIRED derive from time
  revoked_reason text,
  first_entry_at timestamptz,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > valid_from),
  CHECK ((status = 'REVOKED') = (revoked_reason IS NOT NULL))
);
CREATE INDEX access_grants_code_ix ON access.access_grants (property_id, code_hmac) WHERE status <> 'REVOKED';
CREATE INDEX access_grants_plate_ix ON access.access_grants (property_id, plate_hmac) WHERE status <> 'REVOKED';
CREATE TRIGGER access_grants_touch BEFORE UPDATE ON access.access_grants FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE access.access_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES properties.properties (id),
  grant_id    uuid REFERENCES access.access_grants (id),
  gate_id     uuid REFERENCES access.gate_tokens (id),
  kind        text NOT NULL CHECK (kind IN ('ISSUED', 'REISSUED', 'REVOKED', 'VERIFIED', 'DENIED', 'ENTERED', 'CHECKED_IN',
                'PASS_VIEWED', 'EXTERNAL')),
  source      text NOT NULL CHECK (source IN ('GUARD', 'CUSTOMER', 'DRIVER_PASS', 'HOST', 'ADAPTER', 'SYSTEM')),
  method      text CHECK (method IN ('CODE', 'VEHICLE_NUMBER', 'PASS', 'ANPR', 'SMART_LOCK', 'GATE_SYSTEM', 'SOCIETY_SYSTEM')),
  input_hash  bytea,                                     -- hashed lookup input, never the raw plate or code
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_events_property_ix ON access.access_events (property_id, created_at DESC);
CREATE INDEX access_events_grant_ix ON access.access_events (grant_id, created_at) WHERE grant_id IS NOT NULL;
CREATE TRIGGER access_events_append_only BEFORE UPDATE OR DELETE ON access.access_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- Booking issues: the recourse promise (BR-24). One open issue per booking.
CREATE TABLE booking.booking_issues (
  id            uuid PRIMARY KEY,
  booking_id    uuid NOT NULL REFERENCES booking.bookings (id),
  kind          text NOT NULL CHECK (kind IN ('ACCESS_DENIED', 'UNIT_OCCUPIED', 'CHARGER_FAULTY', 'HOST_UNREACHABLE', 'CANNOT_FIND')),
  reporter_kind text NOT NULL CHECK (reporter_kind IN ('CUSTOMER', 'SYSTEM')),
  note          text CHECK (char_length(note) <= 500),
  status        text NOT NULL CHECK (status IN ('OPEN', 'RESOLVED_ON_SITE', 'REFUNDED', 'ESCALATED', 'WITHDRAWN')),
  deadline_at   timestamptz NOT NULL,                    -- host response window; then automatic recourse
  resolved_at   timestamptz,
  resolved_by   text CHECK (resolved_by IN ('CUSTOMER', 'HOST', 'SYSTEM', 'PLATFORM')),
  resolution_note text CHECK (char_length(resolution_note) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX booking_issues_open_uq ON booking.booking_issues (booking_id) WHERE status = 'OPEN';
CREATE INDEX booking_issues_deadline_ix ON booking.booking_issues (deadline_at) WHERE status = 'OPEN';
CREATE TRIGGER booking_issues_touch BEFORE UPDATE ON booking.booking_issues FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
