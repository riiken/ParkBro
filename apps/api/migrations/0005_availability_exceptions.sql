-- 0005 availability_exceptions: host blocks and extra openings (domain-model §3.3, BR-01, BR-04), plus discovery
-- views extended so public search can run the availability engine (unit ids and buffer; never unit labels, which
-- are revealed only after booking, L-6, and never block reasons).

CREATE TABLE availability.availability_exceptions (
  id          uuid PRIMARY KEY,
  asset_id    uuid NOT NULL REFERENCES assets.assets (id),
  unit_id     uuid REFERENCES assets.asset_units (id),      -- null: applies to every unit of the asset
  kind        text NOT NULL CHECK (kind IN ('BLOCK', 'OPEN')),
  period      tstzrange NOT NULL CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  reason      text CHECK (char_length(reason) <= 200),       -- host-only; never public
  created_by  uuid NOT NULL REFERENCES identity.users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX availability_exceptions_asset_period_gix ON availability.availability_exceptions USING gist (asset_id, period);

-- Append buffer_minutes (CREATE OR REPLACE may only add columns at the end).
CREATE OR REPLACE VIEW discovery.published_listings AS
SELECT
  a.id,
  a.asset_type,
  a.title,
  a.description,
  a.rules_text,
  a.approval_required,
  a.min_minutes,
  a.max_minutes,
  a.lead_minutes,
  a.cancellation_policy_code,
  a.updated_at,
  p.public_point,
  p.area_label,
  p.kind              AS property_kind,
  p.timezone,
  CASE WHEN p.kind = 'APARTMENT_SOCIETY' THEN p.display_name END AS society_name,
  h.display_name      AS host_display_name,
  h.kind              AS host_kind,
  h.created_at        AS host_since,
  pd.covered,
  pd.level,
  pd.max_vehicle_class,
  pd.height_cm,
  pd.length_cm,
  pd.security,
  pd.lighting,
  pd.ev_ready_socket,
  pd.tandem,
  cd.connectors,
  cd.current_type,
  cd.power_kw,
  cd.cable_provided,
  (SELECT count(*)::int FROM assets.asset_units u WHERE u.asset_id = a.id AND u.status = 'ACTIVE') AS active_units,
  a.buffer_minutes
FROM assets.assets a
JOIN properties.properties p ON p.id = a.property_id
JOIN identity.host_accounts h ON h.id = a.host_account_id
JOIN assets.parking_details pd ON pd.asset_id = a.id
LEFT JOIN assets.charger_details cd ON cd.asset_id = a.id
WHERE a.status = 'PUBLISHED'
  AND h.status = 'ACTIVE'
  AND p.participation_status IN ('NOT_REQUIRED', 'PARTICIPATING');

-- Unit ids only (labels are private until booking).
CREATE VIEW discovery.published_units AS
SELECT u.asset_id, u.id AS unit_id
FROM assets.asset_units u
JOIN discovery.published_listings l ON l.id = u.asset_id
WHERE u.status = 'ACTIVE';

-- Periods only (no reason, no author).
CREATE VIEW discovery.published_availability_exceptions AS
SELECT e.id, e.asset_id, e.unit_id, e.kind, e.period
FROM availability.availability_exceptions e
JOIN discovery.published_listings l ON l.id = e.asset_id;
