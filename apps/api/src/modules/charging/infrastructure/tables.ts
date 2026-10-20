import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface ChargingSessionsTable {
  id: string;
  booking_id: string;
  asset_id: string;
  customer_id: string;
  status: string;
  integration_kind: string;
  external_ref: string | null;
  metering_source: Generated<string>;
  started_at: Timestamp;
  ended_at: Timestamp;
  energy_wh: ColumnType<string | null, number | null | undefined, number | null>;
  fault_reason: string | null;
  fault_note: string | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface SessionEventsTable {
  id: Generated<string>;
  session_id: string;
  from_status: string | null;
  to_status: string;
  actor_kind: string;
  actor_id: string | null;
  reason: string | null;
  request_id: string | null;
  created_at: CreatedAt;
}

export type ChargingDb = {
  'charging.charging_sessions': ChargingSessionsTable;
  'charging.session_events': SessionEventsTable;
} & AuditTables;
