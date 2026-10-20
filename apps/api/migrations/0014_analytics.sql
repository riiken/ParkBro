-- 0014 analytics (Phase 21; docs/analytics.md; D-159..). Only behaviour that no system of record holds is captured
-- here, and none of it identifies a person: no user, no IP, no exact location (≈1 km cells), coarse times.
CREATE SCHEMA analytics;

CREATE TABLE analytics.search_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  cell        text NOT NULL CHECK (cell ~ '^-?\d{1,2}\.\d{2},-?\d{1,3}\.\d{2}$'),   -- lat,lng rounded to 0.01°
  area_label  text CHECK (char_length(area_label) <= 80),                         -- nearest result's locality, if any
  asset_type  text NOT NULL CHECK (asset_type IN ('PARKING', 'EV_CHARGING')),
  mode        text,
  windowed    boolean NOT NULL,
  result_count integer NOT NULL CHECK (result_count >= 0),
  first_page  boolean NOT NULL
);
CREATE INDEX search_events_at_ix ON analytics.search_events (at);

CREATE TABLE analytics.listing_views (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  asset_id uuid NOT NULL REFERENCES assets.assets (id)
);
CREATE INDEX listing_views_at_ix ON analytics.listing_views (at);
CREATE INDEX listing_views_asset_ix ON analytics.listing_views (asset_id, at);
