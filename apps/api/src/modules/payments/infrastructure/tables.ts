import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Money = ColumnType<string, number, number>;

export interface PaymentsTable {
  id: string;
  booking_id: string;
  customer_id: string;
  provider: string;
  provider_order_id: string;
  provider_payment_id: string | null;
  amount_paise: Money;
  currency: Generated<string>;
  status: string;
  method: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  mismatch: Generated<boolean>;
  idempotency_key: string;
  succeeded_at: Timestamp;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface PaymentEventsTable {
  id: Generated<string>;
  payment_id: string;
  from_status: string | null;
  to_status: string;
  source: string;
  detail: string | null;
  request_id: string | null;
  created_at: CreatedAt;
}

export interface RefundsTable {
  id: string;
  payment_id: string;
  booking_id: string;
  amount_paise: Money;
  reason: string;
  status: string;
  provider_refund_id: string | null;
  failure_reason: string | null;
  attempts: Generated<number>;
  idempotency_key: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface ProviderEventsTable {
  id: Generated<string>;
  provider: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  received_at: CreatedAt;
  claimed_at: Timestamp;
  processed_at: Timestamp;
  quarantined_reason: string | null;
}

export interface SettlementLinesTable {
  id: Generated<string>;
  provider: string;
  settlement_id: string;
  entity_kind: string;
  provider_entity_id: string;
  amount_paise: Money;
  fee_paise: Money;
  tax_paise: Money;
  settled_at: Date;
  imported_at: CreatedAt;
}

export interface ReconciliationItemsTable {
  id: string;
  kind: string;
  refs: unknown;
  dedupe_key: string;
  status: Generated<string>;
  note: string | null;
  resolved_by: string | null;
  created_at: CreatedAt;
  resolved_at: Timestamp;
}

export type PaymentsDb = {
  'payments.payments': PaymentsTable;
  'payments.payment_events': PaymentEventsTable;
  'payments.refunds': RefundsTable;
  'payments.provider_events': ProviderEventsTable;
  'payments.settlement_lines': SettlementLinesTable;
  'payments.reconciliation_items': ReconciliationItemsTable;
} & AuditTables;
