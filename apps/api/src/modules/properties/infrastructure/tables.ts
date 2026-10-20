import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

export interface PropertiesTable {
  id: string;
  kind: string;
  display_name: string | null;
  exact_address_enc: Buffer;
  exact_point_enc: Buffer;
  public_point: unknown; // geography; written and read through SQL expressions
  area_label: string;
  timezone: string;
  participation_status: string;
  owner_host_account_id: string | null;
  outsider_cap: number | null;
  created_by: string;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface PropertyMembersTable {
  property_id: string;
  host_account_id: string;
  role: string;
  status: Generated<string>;
  approved_by: string;
  created_at: CreatedAt;
}

export interface PropertyEventsTable {
  id: Generated<string>;
  property_id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  reason: string | null;
  request_id: string | null;
  created_at: CreatedAt;
}

export type PropertiesTables = {
  'properties.properties': PropertiesTable;
  'properties.property_members': PropertyMembersTable;
  'properties.property_events': PropertyEventsTable;
};

export type PropertiesDb = PropertiesTables & AuditTables;
