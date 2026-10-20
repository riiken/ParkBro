-- 0003 hosts_properties_assets: host accounts, properties (society participation, private exact location +
-- stable public point), society member hosts, the generic asset model (types, assets, units, details, media,
-- history), rates, availability rules (storage only; engine in Phase 11) and verification records.
-- Design: docs/domain-model.md §3, §5.1, §5.2; docs/database-design.md §3; docs/trust-and-safety.md §3, §6, §9.

-- ------------------------------------------------------------------ hosts (identity schema)
CREATE TABLE identity.host_accounts (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('INDIVIDUAL', 'BUSINESS')),
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED')),
  created_by    uuid NOT NULL REFERENCES identity.users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER host_accounts_touch BEFORE UPDATE ON identity.host_accounts
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE identity.host_members (
  host_account_id uuid NOT NULL REFERENCES identity.host_accounts (id),
  user_id         uuid NOT NULL REFERENCES identity.users (id),
  role            text NOT NULL CHECK (role IN ('OWNER', 'MANAGER')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_account_id, user_id)
);
CREATE INDEX host_members_user_ix ON identity.host_members (user_id);
-- Pilot: a user owns at most one host account (managers of business accounts come later).
CREATE UNIQUE INDEX host_members_one_owned_account_uq ON identity.host_members (user_id) WHERE role = 'OWNER';

-- ------------------------------------------------------------------ properties
CREATE SCHEMA properties;

CREATE TABLE properties.properties (
  id                    uuid PRIMARY KEY,
  kind                  text NOT NULL CHECK (kind IN ('APARTMENT_SOCIETY', 'INDEPENDENT_HOUSE', 'COMMERCIAL', 'OFFICE', 'OTHER')),
  display_name          text CHECK (char_length(display_name) <= 80),      -- societies only, if they opt in to be named
  exact_address_enc     bytea NOT NULL,                                     -- field cipher
  exact_point_enc       bytea NOT NULL,                                     -- field cipher ("lat,lng"); never queried
  public_point          geography(Point, 4326) NOT NULL,                    -- stable fuzzed point (L-1)
  area_label            text NOT NULL CHECK (char_length(area_label) BETWEEN 2 AND 80),
  timezone              text NOT NULL DEFAULT 'Asia/Kolkata',
  participation_status  text NOT NULL CHECK (participation_status IN
                          ('NOT_REQUIRED', 'CONSENT_REQUIRED', 'PENDING_CONSENT', 'PARTICIPATING', 'SUSPENDED', 'WITHDRAWN')),
  owner_host_account_id uuid REFERENCES identity.host_accounts (id),       -- houses / commercial; null for societies
  outsider_cap          integer CHECK (outsider_cap IS NULL OR outsider_cap > 0),
  created_by            uuid NOT NULL REFERENCES identity.users (id),
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Societies need consent-based participation and no single owner; other kinds are owned by one host.
  CHECK (
    (kind = 'APARTMENT_SOCIETY' AND owner_host_account_id IS NULL AND participation_status <> 'NOT_REQUIRED')
    OR (kind <> 'APARTMENT_SOCIETY' AND owner_host_account_id IS NOT NULL AND participation_status = 'NOT_REQUIRED')
  )
);
CREATE INDEX properties_public_point_gix ON properties.properties USING gist (public_point);
CREATE INDEX properties_owner_ix ON properties.properties (owner_host_account_id);
CREATE TRIGGER properties_touch BEFORE UPDATE ON properties.properties
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE properties.property_members (
  property_id     uuid NOT NULL REFERENCES properties.properties (id),
  host_account_id uuid NOT NULL REFERENCES identity.host_accounts (id),
  role            text NOT NULL CHECK (role IN ('MEMBER_HOST')),             -- PROPERTY_ADMIN members later (PJ-1)
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  approved_by     uuid NOT NULL REFERENCES identity.users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, host_account_id)
);

CREATE TABLE properties.property_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES properties.properties (id),
  from_status text,
  to_status   text NOT NULL,
  actor_id    uuid,
  reason      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER property_events_append_only BEFORE UPDATE OR DELETE ON properties.property_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- ------------------------------------------------------------------ assets
CREATE SCHEMA assets;

CREATE TABLE assets.asset_types (
  code                  text PRIMARY KEY,
  allowed_modes         text[] NOT NULL,
  required_media_kinds  text[] NOT NULL,
  required_attestations text[] NOT NULL,
  has_session           boolean NOT NULL
);
INSERT INTO assets.asset_types (code, allowed_modes, required_media_kinds, required_attestations, has_session) VALUES
  ('PARKING',     ARRAY['HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY'], ARRAY['SLOT'],            ARRAY['RIGHT_TO_RENT'],                   false),
  ('EV_CHARGING', ARRAY['CHARGING_SESSION'],                        ARRAY['SLOT', 'CHARGER'], ARRAY['RIGHT_TO_RENT', 'CHARGER_SAFETY'], true);

CREATE TABLE assets.assets (
  id                       uuid PRIMARY KEY,
  property_id              uuid NOT NULL REFERENCES properties.properties (id),
  host_account_id          uuid NOT NULL REFERENCES identity.host_accounts (id),
  asset_type               text NOT NULL REFERENCES assets.asset_types (code),
  status                   text NOT NULL DEFAULT 'DRAFT'
                             CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'PAUSED', 'SUSPENDED', 'ARCHIVED')),
  needs_review             boolean NOT NULL DEFAULT false,    -- material change while PAUSED: republish goes to review
  title                    text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 80),
  description              text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  rules_text               text NOT NULL DEFAULT '' CHECK (char_length(rules_text) <= 1000),
  access_instructions_enc  bytea,                              -- private until a confirmed booking (L-6)
  approval_required        boolean NOT NULL DEFAULT false,
  buffer_minutes           integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  min_minutes              integer NOT NULL DEFAULT 60 CHECK (min_minutes BETWEEN 15 AND 43200),
  max_minutes              integer NOT NULL DEFAULT 1440 CHECK (max_minutes BETWEEN 15 AND 1440 * 31),
  lead_minutes             integer NOT NULL DEFAULT 0 CHECK (lead_minutes BETWEEN 0 AND 10080),
  cancellation_policy_code text NOT NULL DEFAULT 'MODERATE' CHECK (cancellation_policy_code IN ('FLEXIBLE', 'MODERATE', 'STRICT')),
  status_reason            text,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (min_minutes <= max_minutes)
);
CREATE INDEX assets_host_ix ON assets.assets (host_account_id);
CREATE INDEX assets_property_ix ON assets.assets (property_id);
CREATE INDEX assets_status_type_ix ON assets.assets (status, asset_type);
CREATE TRIGGER assets_touch BEFORE UPDATE ON assets.assets FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE assets.asset_units (
  id         uuid PRIMARY KEY,
  asset_id   uuid NOT NULL REFERENCES assets.assets (id),
  label      text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 30),
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, label)
);

-- Bay description for every asset (PARKING spaces and EV charging bays).
CREATE TABLE assets.parking_details (
  asset_id          uuid PRIMARY KEY REFERENCES assets.assets (id),
  covered           boolean NOT NULL,
  level             text NOT NULL CHECK (level IN ('BASEMENT', 'STILT', 'GROUND', 'OPEN_LOT', 'MULTI_LEVEL')),
  max_vehicle_class text NOT NULL CHECK (max_vehicle_class IN ('HATCHBACK', 'SEDAN', 'SUV', 'MUV')),
  height_cm         integer CHECK (height_cm BETWEEN 150 AND 500),
  length_cm         integer CHECK (length_cm BETWEEN 300 AND 800),
  security          text[] NOT NULL DEFAULT '{}' CHECK (security <@ ARRAY['CCTV', 'GUARD', 'GATED']::text[]),
  lighting          boolean NOT NULL DEFAULT false,
  ev_ready_socket   boolean NOT NULL DEFAULT false,
  tandem            boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets.charger_details (
  asset_id        uuid PRIMARY KEY REFERENCES assets.assets (id),
  connectors      text[] NOT NULL CHECK (cardinality(connectors) >= 1 AND connectors <@
                    ARRAY['TYPE2', 'CCS2', 'BHARAT_AC001', 'BHARAT_DC001', 'IEC_15A', 'GBT']::text[]),
  current_type    text NOT NULL CHECK (current_type IN ('AC', 'DC')),
  power_kw        numeric(5, 1) NOT NULL CHECK (power_kw > 0 AND power_kw <= 400),
  cable_provided  boolean NOT NULL,
  connection_type text NOT NULL CHECK (connection_type IN ('DOMESTIC', 'EV_METERED', 'COMMERCIAL')),
  metering_source text NOT NULL DEFAULT 'NONE' CHECK (metering_source IN ('NONE', 'HOST_REPORTED', 'CHARGER_API')),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charger_details_connectors_gix ON assets.charger_details USING gin (connectors);

CREATE TABLE assets.asset_media (
  id                     uuid PRIMARY KEY,
  asset_id               uuid NOT NULL REFERENCES assets.assets (id),
  kind                   text NOT NULL CHECK (kind IN ('SLOT', 'ENTRANCE', 'CHARGER', 'OTHER')),
  storage_key            text NOT NULL UNIQUE,
  content_type           text NOT NULL CHECK (content_type IN ('image/webp')),
  width                  integer NOT NULL,
  height                 integer NOT NULL,
  byte_size              integer NOT NULL,
  sha256                 bytea NOT NULL,
  phash                  bigint NOT NULL,         -- 64-bit dHash; near-duplicates: bit_count((a # b)::bit(64)) <= 6 (V-PHOTO)
  duplicate_suspected    boolean NOT NULL DEFAULT false,  -- near-duplicate of another host's photo: surfaced in review
  capture_distance_m     integer,                 -- V-GEO soft check: distance from the property's exact point
  moderation_status      text NOT NULL DEFAULT 'PENDING' CHECK (moderation_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  position               integer NOT NULL DEFAULT 0,
  removed_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_media_asset_ix ON assets.asset_media (asset_id) WHERE removed_at IS NULL;
CREATE INDEX asset_media_phash_ix ON assets.asset_media (phash);

CREATE TABLE assets.asset_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id    uuid NOT NULL REFERENCES assets.assets (id),
  from_status text,
  to_status   text NOT NULL,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('HOST', 'PLATFORM_ADMIN', 'SYSTEM')),
  actor_id    uuid,
  reason      text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_events_asset_ix ON assets.asset_events (asset_id, created_at);
CREATE TRIGGER asset_events_append_only BEFORE UPDATE OR DELETE ON assets.asset_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- ------------------------------------------------------------------ pricing (rates only; quotes in Phase 12)
CREATE SCHEMA pricing;

CREATE TABLE pricing.rates (
  id              uuid PRIMARY KEY,
  asset_id        uuid NOT NULL REFERENCES assets.assets (id),
  mode            text NOT NULL CHECK (mode IN ('HOURLY', 'DAILY', 'OVERNIGHT', 'MONTHLY', 'CHARGING_SESSION')),
  unit            text NOT NULL CHECK (unit IN ('PER_HOUR', 'PER_DAY', 'PER_NIGHT', 'PER_MONTH', 'PER_SESSION')),
  price_paise     bigint NOT NULL CHECK (price_paise BETWEEN 100 AND 10000000),   -- ₹1 – ₹1,00,000
  overnight_start time,
  overnight_end   time,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,                    -- history is kept; existing bookings snapshot prices (BR-17)
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'OVERNIGHT') = (overnight_start IS NOT NULL AND overnight_end IS NOT NULL)),
  CHECK (
    (mode = 'HOURLY' AND unit = 'PER_HOUR') OR (mode = 'DAILY' AND unit = 'PER_DAY')
    OR (mode = 'OVERNIGHT' AND unit = 'PER_NIGHT') OR (mode = 'MONTHLY' AND unit = 'PER_MONTH')
    OR (mode = 'CHARGING_SESSION' AND unit IN ('PER_HOUR', 'PER_SESSION'))
  )
);
CREATE UNIQUE INDEX rates_current_uq ON pricing.rates (asset_id, mode) WHERE retired_at IS NULL;

-- ------------------------------------------------------------------ availability (rule storage; engine in Phase 11)
CREATE SCHEMA availability;

CREATE TABLE availability.availability_rules (
  id          uuid PRIMARY KEY,
  asset_id    uuid NOT NULL REFERENCES assets.assets (id),
  weekdays    smallint[] NOT NULL CHECK (cardinality(weekdays) >= 1 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  start_local time NOT NULL,
  end_local   time NOT NULL,     -- end <= start means the window crosses midnight; equal means 24 h
  valid_from  date NOT NULL DEFAULT current_date,
  valid_to    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX availability_rules_asset_ix ON availability.availability_rules (asset_id);

-- ------------------------------------------------------------------ trust: verification records
CREATE SCHEMA trust;

CREATE TABLE trust.verification_records (
  id                uuid PRIMARY KEY,
  subject_kind      text NOT NULL CHECK (subject_kind IN ('USER', 'HOST_ACCOUNT', 'VEHICLE', 'PROPERTY', 'ASSET')),
  subject_id        uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('RIGHT_TO_RENT', 'CHARGER_SAFETY', 'SOCIETY_CONSENT', 'PHOTO_REVIEW', 'SITE_VISIT')),
  method            text NOT NULL CHECK (method IN ('SELF_ATTESTATION', 'ADMIN_REVIEW', 'DOCUMENT', 'FIELD_VISIT')),
  status            text NOT NULL CHECK (status IN ('PENDING', 'ATTESTED', 'VERIFIED', 'REJECTED', 'EXPIRED')),
  statement_version text,            -- the exact attestation wording the host accepted
  actor_id          uuid NOT NULL,
  note              text CHECK (char_length(note) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz
);
CREATE INDEX verification_records_subject_ix ON trust.verification_records (subject_kind, subject_id, kind, created_at);
