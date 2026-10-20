import type { ColumnType, Generated } from 'kysely';

type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Timestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface NotificationsTable {
  id: string;
  user_id: string;
  template: string;
  category: string;
  channel: string;
  vars: unknown;
  link: string | null;
  dedupe_key: string;
  status: string;
  suppressed_reason: string | null;
  attempts: Generated<number>;
  next_attempt_at: ColumnType<Date, Date | string | undefined, Date | string>;
  claimed_at: Timestamp;
  provider: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  sent_at: Timestamp;
  delivered_at: Timestamp;
  read_at: Timestamp;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}
export interface PreferencesTable {
  user_id: string;
  channel: string;
  enabled: boolean;
  updated_at: Generated<Date>;
}
export type NotificationsDb = {
  'notifications.notifications': NotificationsTable;
  'notifications.preferences': PreferencesTable;
};
