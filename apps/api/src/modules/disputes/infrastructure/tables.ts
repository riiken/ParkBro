import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface DisputesTable {
  id: string;
  booking_id: string;
  opened_by_kind: string;
  opened_by: string;
  customer_id: string;
  host_account_id: string;
  category: string;
  risk: string;
  requested_outcome: string;
  status: string;
  outcome: string | null;
  refund_paise: ColumnType<string | null, number | null | undefined, number | null>;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: Timestamp;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}
export interface DisputeMessagesTable {
  id: Generated<string>;
  dispute_id: string;
  author_kind: string;
  author_id: string | null;
  body: string;
  internal: Generated<boolean>;
  created_at: CreatedAt;
}
export interface DisputeEvidenceTable {
  id: string;
  dispute_id: string;
  uploaded_by_kind: string;
  uploaded_by: string;
  storage_key: string;
  content_type: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: Buffer;
  created_at: CreatedAt;
}
export type DisputesDb = {
  'disputes.disputes': DisputesTable;
  'disputes.dispute_messages': DisputeMessagesTable;
  'disputes.dispute_evidence': DisputeEvidenceTable;
} & AuditTables;
