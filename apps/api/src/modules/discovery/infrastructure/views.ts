import type { ColumnType } from 'kysely';

type Numeric = ColumnType<string, never, never>;

/** Read-only views from migration 0004 (no exact location, address or access instructions exist in them). */
export interface PublishedListingsView {
  id: string;
  asset_type: string;
  title: string;
  description: string;
  rules_text: string;
  approval_required: boolean;
  min_minutes: number;
  max_minutes: number;
  lead_minutes: number;
  cancellation_policy_code: string;
  updated_at: Date;
  public_point: unknown;
  area_label: string;
  property_kind: string;
  timezone: string;
  society_name: string | null;
  host_display_name: string;
  host_kind: string;
  host_since: Date;
  covered: boolean;
  level: string;
  max_vehicle_class: string;
  height_cm: number | null;
  length_cm: number | null;
  security: string[];
  lighting: boolean;
  ev_ready_socket: boolean;
  tandem: boolean;
  connectors: string[] | null;
  current_type: string | null;
  power_kw: Numeric | null;
  cable_provided: boolean | null;
  active_units: number;
  buffer_minutes: number;
}

export interface PublishedUnitsView {
  asset_id: string;
  unit_id: string;
}

export interface PublishedExceptionsView {
  id: string;
  asset_id: string;
  unit_id: string | null;
  kind: string;
  period: unknown;
}

export interface PublishedRatesView {
  asset_id: string;
  mode: string;
  unit: string;
  price_paise: Numeric;
  overnight_start: string | null;
  overnight_end: string | null;
}

export interface PublicPhotosView {
  id: string;
  asset_id: string;
  kind: string;
  width: number;
  height: number;
  position: number;
  created_at: Date;
}

export interface PublishedRulesView {
  asset_id: string;
  weekdays: number[];
  start_local: string;
  end_local: string;
  valid_from: string;
  valid_to: string | null;
}

export type DiscoveryDb = {
  'discovery.published_listings': PublishedListingsView;
  'discovery.published_rates': PublishedRatesView;
  'discovery.public_photos': PublicPhotosView;
  'discovery.published_availability_rules': PublishedRulesView;
  'discovery.published_units': PublishedUnitsView;
  'discovery.published_availability_exceptions': PublishedExceptionsView;
};
