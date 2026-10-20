import type { ColumnType, Generated } from 'kysely';
import type { AuditTables } from '../../../platform/audit/audit-log.ts';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

export interface UsersTable {
  id: string;
  phone_enc: Buffer;
  phone_hmac: Buffer | null;
  phone_last4: string;
  display_name: string;
  locale: Generated<string>;
  status: Generated<string>;
  age_attested_at: Timestamp;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface RoleGrantsTable {
  user_id: string;
  role: string;
  granted_by: string | null;
  granted_at: Generated<Date>;
}

export interface AdminPermissionsTable {
  user_id: string;
  permission: string;
  granted_by: string | null;
  granted_at: Generated<Date>;
}

export interface AdminMfaTable {
  user_id: string;
  totp_secret_enc: Buffer;
  // int8 comes back from pg as a string
  last_used_step: ColumnType<string, number | undefined, number>;
  enabled_at: Generated<Date>;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  kind: string;
  token_hash: Buffer;
  created_at: CreatedAt;
  last_seen_at: Timestamp;
  expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason: string | null;
  user_agent: string | null;
}

export interface OtpChallengesTable {
  id: string;
  purpose: string;
  phone_hmac: Buffer;
  phone_enc: Buffer;
  code_hash: Buffer;
  attempts: Generated<number>;
  status: Generated<string>;
  expires_at: Timestamp;
  verified_at: Timestamp | null;
  ticket_hash: Buffer | null;
  ticket_expires_at: Timestamp | null;
  ticket_attempts: Generated<number>;
  created_at: CreatedAt;
}

export interface ConsentsTable {
  id: string;
  user_id: string;
  purpose: string;
  notice_version: string;
  granted_at: Generated<Date>;
  withdrawn_at: Timestamp | null;
}

export interface HostAccountsTable {
  id: string;
  kind: string;
  display_name: string;
  status: Generated<string>;
  created_by: string;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface HostMembersTable {
  host_account_id: string;
  user_id: string;
  role: string;
  created_at: CreatedAt;
}

export type IdentityTables = {
  'identity.users': UsersTable;
  'identity.role_grants': RoleGrantsTable;
  'identity.admin_permissions': AdminPermissionsTable;
  'identity.admin_mfa': AdminMfaTable;
  'identity.sessions': SessionsTable;
  'identity.otp_challenges': OtpChallengesTable;
  'identity.consents': ConsentsTable;
  'identity.host_accounts': HostAccountsTable;
  'identity.host_members': HostMembersTable;
};

export type IdentityDb = IdentityTables & AuditTables;
