-- 0004 discovery_views: the ONLY data public discovery can read (architecture.md §4.2 read-only query modules).
-- These views structurally exclude exact addresses, exact points, access instructions, entrance photos,
-- unapproved photos and unpublished listings, so a public endpoint cannot leak them (trust-and-safety L-2, L-5, L-9).

CREATE SCHEMA discovery;

CREATE VIEW discovery.published_listings AS
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
  CASE WHEN p.kind = 'APARTMENT_SOCIETY' THEN p.display_name END AS society_name,  -- societies opt in to be named (L-4)
  h.display_name      AS host_display_name,     -- individuals are shown by first name only (L-8)
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
  (SELECT count(*)::int FROM assets.asset_units u WHERE u.asset_id = a.id AND u.status = 'ACTIVE') AS active_units
FROM assets.assets a
JOIN properties.properties p ON p.id = a.property_id
JOIN identity.host_accounts h ON h.id = a.host_account_id
JOIN assets.parking_details pd ON pd.asset_id = a.id
LEFT JOIN assets.charger_details cd ON cd.asset_id = a.id
WHERE a.status = 'PUBLISHED'
  AND h.status = 'ACTIVE'
  AND p.participation_status IN ('NOT_REQUIRED', 'PARTICIPATING');

CREATE VIEW discovery.published_rates AS
SELECT r.asset_id, r.mode, r.unit, r.price_paise, r.overnight_start, r.overnight_end
FROM pricing.rates r
JOIN discovery.published_listings l ON l.id = r.asset_id
WHERE r.retired_at IS NULL;

CREATE VIEW discovery.public_photos AS
SELECT m.id, m.asset_id, m.kind, m.width, m.height, m.position, m.created_at
FROM assets.asset_media m
JOIN discovery.published_listings l ON l.id = m.asset_id
WHERE m.removed_at IS NULL
  AND m.moderation_status = 'APPROVED'
  AND m.kind <> 'ENTRANCE';

CREATE VIEW discovery.published_availability_rules AS
SELECT r.asset_id, r.weekdays, r.start_local, r.end_local, r.valid_from, r.valid_to
FROM availability.availability_rules r
JOIN discovery.published_listings l ON l.id = r.asset_id;

-- Search filters on mode + price.
CREATE INDEX rates_live_mode_price_ix ON pricing.rates (mode, price_paise) WHERE retired_at IS NULL;
