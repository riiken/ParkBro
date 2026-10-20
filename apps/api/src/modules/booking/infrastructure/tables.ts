import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface BookingsTable {
  id: string;
  customer_id: string;
  vehicle_id: string;
  asset_id: string;
  unit_id: string;
  host_account_id: string;
  property_id: string;
  asset_type: string;
  mode: string;
  period: unknown; // tstzrange
  buffer_minutes: number;
  blocked_period: ColumnType<unknown, never, never>; // set by trigger
  status: string;
  holds_unit: ColumnType<boolean, never, never>; // generated
  hold_expires_at: Timestamp;
  approval_expires_at: Timestamp;
  quote_id: string | null; // null only for system-created renewal periods
  series_id: ColumnType<string | null, string | null | undefined, never>;
  period_index: ColumnType<number | null, number | null | undefined, never>;
  price_snapshot: unknown;
  policy_snapshot: unknown;
  total_paise: ColumnType<string, number, number>;
  idempotency_key: string;
  cancelled_by: string | null;
  cancel_reason: string | null;
  refund_paise: ColumnType<string | null, number | null, number | null>;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface BookingEventsTable {
  id: Generated<string>;
  booking_id: string;
  from_status: string | null;
  to_status: string;
  actor_kind: string;
  actor_id: string | null;
  reason: string | null;
  request_id: string | null;
  created_at: CreatedAt;
}

export interface SeriesTable {
  id: string;
  customer_id: string;
  vehicle_id: string;
  asset_id: string;
  unit_id: string;
  host_account_id: string;
  property_id: string;
  cadence: string;
  anchor_start: Date;
  timezone: string;
  status: string;
  period_price_snapshot: unknown;
  period_total_paise: ColumnType<string, number, number>;
  policy_snapshot: unknown;
  notice_days: Generated<number>;
  grace_days: Generated<number>;
  notice_given_at: Timestamp;
  notice_by: string | null;
  ends_at: Timestamp;
  ended_reason: string | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface SeriesEventsTable {
  id: Generated<string>;
  series_id: string;
  from_status: string | null;
  to_status: string;
  actor_kind: string;
  actor_id: string | null;
  reason: string | null;
  request_id: string | null;
  created_at: CreatedAt;
}

export interface BookingIssuesTable {
  id: string;
  booking_id: string;
  kind: string;
  reporter_kind: string;
  note: string | null;
  status: string;
  deadline_at: Date;
  resolved_at: Timestamp;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export type BookingTables = {
  'booking.booking_issues': BookingIssuesTable;
  'booking.bookings': BookingsTable;
  'booking.booking_events': BookingEventsTable;
  'booking.booking_series': SeriesTable;
  'booking.series_events': SeriesEventsTable;
};

export type BookingDb = BookingTables & AuditTables;
