import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface ReviewsTable {
  id: string;
  booking_id: string;
  author_kind: string;
  author_id: string;
  asset_id: string;
  host_account_id: string;
  customer_id: string;
  rating: number;
  dimensions: unknown;
  body: string | null;
  status: string;
  removed_reason: string | null;
  published_at: Timestamp;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}
export type ReviewsDb = { 'reviews.reviews': ReviewsTable } & AuditTables;
