import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

export interface AssetTypesTable {
  code: string;
  allowed_modes: string[];
  required_media_kinds: string[];
  required_attestations: string[];
  has_session: boolean;
}

export interface AssetsTable {
  id: string;
  property_id: string;
  host_account_id: string;
  asset_type: string;
  status: Generated<string>;
  needs_review: Generated<boolean>;
  title: string;
  description: Generated<string>;
  rules_text: Generated<string>;
  access_instructions_enc: Buffer | null;
  approval_required: Generated<boolean>;
  buffer_minutes: Generated<number>;
  min_minutes: Generated<number>;
  max_minutes: Generated<number>;
  lead_minutes: Generated<number>;
  cancellation_policy_code: Generated<string>;
  status_reason: string | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface AssetUnitsTable {
  id: string;
  asset_id: string;
  label: string;
  status: Generated<string>;
  created_at: CreatedAt;
}

export interface ParkingDetailsTable {
  asset_id: string;
  covered: boolean;
  level: string;
  max_vehicle_class: string;
  height_cm: number | null;
  length_cm: number | null;
  security: string[];
  lighting: boolean;
  ev_ready_socket: boolean;
  tandem: boolean;
  updated_at: Generated<Date>;
}

export interface ChargerDetailsTable {
  asset_id: string;
  connectors: string[];
  current_type: string;
  power_kw: ColumnType<string, number, number>; // numeric → string from pg
  cable_provided: boolean;
  connection_type: string;
  metering_source: Generated<string>;
  integration_kind: Generated<string>;
  integration_ref: string | null;
  updated_at: Generated<Date>;
}

export interface AssetMediaTable {
  id: string;
  asset_id: string;
  kind: string;
  storage_key: string;
  content_type: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: Buffer;
  phash: string;
  duplicate_suspected: Generated<boolean>;
  capture_distance_m: number | null;
  moderation_status: Generated<string>;
  position: Generated<number>;
  removed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
}

export interface AssetEventsTable {
  id: Generated<string>;
  asset_id: string;
  from_status: string | null;
  to_status: string;
  actor_kind: string;
  actor_id: string | null;
  reason: string | null;
  request_id: string | null;
  created_at: CreatedAt;
}

export type AssetsTables = {
  'assets.asset_types': AssetTypesTable;
  'assets.assets': AssetsTable;
  'assets.asset_units': AssetUnitsTable;
  'assets.parking_details': ParkingDetailsTable;
  'assets.charger_details': ChargerDetailsTable;
  'assets.asset_media': AssetMediaTable;
  'assets.asset_events': AssetEventsTable;
};

export type AssetsDb = AssetsTables & AuditTables;
