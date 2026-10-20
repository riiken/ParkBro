-- 0008 charging: the charging part of an EV_CHARGING booking (domain-model §3.6, §5.9; D-005, D-114..). No live
-- hardware is assumed: the pilot integration is MANUAL (self-reported start/stop). Smart chargers plug in later
-- through the ChargerIntegration interface using charger_details.integration_kind / integration_ref.
CREATE SCHEMA charging;

ALTER TABLE assets.charger_details
  ADD COLUMN integration_kind text NOT NULL DEFAULT 'MANUAL' CHECK (integration_kind IN ('MANUAL')),
  ADD COLUMN integration_ref  text CHECK (char_length(integration_ref) <= 200);   -- e.g. OCPP charge point id later

CREATE TABLE charging.charging_sessions (
  id               uuid PRIMARY KEY,
  booking_id       uuid NOT NULL UNIQUE REFERENCES booking.bookings (id),   -- one session per booking
  asset_id         uuid NOT NULL REFERENCES assets.assets (id),
  customer_id      uuid NOT NULL REFERENCES identity.users (id),
  status           text NOT NULL CHECK (status IN ('NOT_STARTED', 'CHARGING', 'COMPLETED', 'STOPPED_EARLY', 'FAULTED')),
  integration_kind text NOT NULL CHECK (integration_kind IN ('MANUAL')),
  external_ref     text CHECK (char_length(external_ref) <= 200),           -- the integration's session id
  metering_source  text NOT NULL DEFAULT 'NONE' CHECK (metering_source IN ('NONE', 'HOST_REPORTED', 'CHARGER_API')),
  started_at       timestamptz,
  ended_at         timestamptz,
  energy_wh        bigint CHECK (energy_wh >= 0),                         -- informational only without metering (BR-28)
  fault_reason     text CHECK (fault_reason IN ('NOT_WORKING', 'CONNECTOR_DAMAGED', 'NO_POWER', 'CANNOT_REACH', 'OTHER')),
  fault_note       text CHECK (char_length(fault_note) <= 500),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('CHARGING', 'COMPLETED', 'STOPPED_EARLY') OR started_at IS NOT NULL),
  CHECK (status NOT IN ('COMPLETED', 'STOPPED_EARLY') OR ended_at IS NOT NULL),
  CHECK ((status = 'FAULTED') = (fault_reason IS NOT NULL)),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX charging_sessions_active_ix ON charging.charging_sessions (status) WHERE status = 'CHARGING';
CREATE TRIGGER charging_sessions_touch BEFORE UPDATE ON charging.charging_sessions
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE charging.session_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES charging.charging_sessions (id),
  from_status text,
  to_status   text NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('CUSTOMER', 'HOST', 'SYSTEM', 'INTEGRATION')),
  actor_id    uuid,
  reason      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_events_session_ix ON charging.session_events (session_id, created_at);
CREATE TRIGGER session_events_append_only BEFORE UPDATE OR DELETE ON charging.session_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
