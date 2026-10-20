import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface GateTokensTable {
  id: string;
  property_id: string;
  label: string;
  token_hash: Buffer;
  status: Generated<string>;
  expires_at: Date;
  created_by: string;
  created_at: CreatedAt;
}
export interface AccessGrantsTable {
  id: string;
  booking_id: string;
  property_id: string;
  asset_id: string;
  unit_id: string;
  customer_id: string;
  vehicle_id: string;
  plate_hmac: Buffer;
  plate_last4: string;
  code_hmac: Buffer;
  code_enc: Buffer;
  valid_from: Date;
  valid_until: Date;
  status: string;
  revoked_reason: string | null;
  first_entry_at: Timestamp;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}
export interface AccessEventsTable {
  id: Generated<string>;
  property_id: string;
  grant_id: string | null;
  gate_id: string | null;
  kind: string;
  source: string;
  method: string | null;
  input_hash: Buffer | null;
  detail: string | null;
  created_at: CreatedAt;
}
export type AccessDb = {
  'access.gate_tokens': GateTokensTable;
  'access.access_grants': AccessGrantsTable;
  'access.access_events': AccessEventsTable;
} & AuditTables;
