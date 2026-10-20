import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Money = ColumnType<string, number, number>;

export interface AccountsTable {
  id: string;
  code: string;
  owner_kind: string;
  owner_id: string | null;
  created_at: CreatedAt;
}
export interface JournalsTable {
  id: string;
  kind: string;
  booking_id: string | null;
  payment_id: string | null;
  refund_id: string | null;
  payout_id: string | null;
  host_account_id: string | null;
  memo: string | null;
  idempotency_key: string;
  created_at: CreatedAt;
}
export interface EntriesTable {
  id: Generated<string>;
  journal_id: string;
  account_id: string;
  direction: string;
  amount_paise: Money;
  created_at: CreatedAt;
}
export interface PayoutAccountsTable {
  id: string;
  host_account_id: string;
  method: string;
  holder_name: string;
  details_enc: Buffer;
  display_last4: string;
  ifsc: string | null;
  status: string;
  verified_at: Timestamp;
  verified_by: string | null;
  hold_until: Timestamp;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}
export interface PayoutsTable {
  id: string;
  host_account_id: string;
  payout_account_id: string;
  amount_paise: Money;
  status: string;
  provider: string;
  provider_reference: string | null;
  failure_reason: string | null;
  idempotency_key: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
  settled_at: Timestamp;
  settled_by: string | null;
}

export type EarningsDb = {
  'ledger.accounts': AccountsTable;
  'ledger.journals': JournalsTable;
  'ledger.entries': EntriesTable;
  'payouts.payout_accounts': PayoutAccountsTable;
  'payouts.payouts': PayoutsTable;
} & AuditTables;
