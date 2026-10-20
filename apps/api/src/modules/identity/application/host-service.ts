import type { Kysely } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import { DomainError } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';

export type HostAccountKind = 'INDIVIDUAL' | 'BUSINESS';
export type HostMemberRole = 'OWNER' | 'MANAGER';

export interface HostAccess {
  hostAccountId: string;
  role: HostMemberRole;
  status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED';
  kind: HostAccountKind;
  displayName: string;
}

/** Host accounts (domain-model §3.1): the party that lists assets and earns, separate from the login. */
export function createHostService(deps: { db: Kysely<IdentityDb>; audit: AuditLog }) {
  const { db, audit } = deps;

  async function hostAccessFor(userId: string): Promise<HostAccess | null> {
    const row = await db
      .selectFrom('identity.host_members as m')
      .innerJoin('identity.host_accounts as a', 'a.id', 'm.host_account_id')
      .select(['a.id', 'a.kind', 'a.display_name', 'a.status', 'm.role'])
      .where('m.user_id', '=', userId)
      .orderBy('m.created_at')
      .executeTakeFirst();
    if (!row) return null;
    return {
      hostAccountId: row.id,
      role: row.role as HostMemberRole,
      status: row.status as HostAccess['status'],
      kind: row.kind as HostAccountKind,
      displayName: row.display_name,
    };
  }

  /** Become a host: creates an account owned by the user and grants the HOST role (idempotent per user). */
  async function becomeHost(
    userId: string,
    input: { kind: HostAccountKind; displayName: string },
    requestId: string,
  ): Promise<HostAccess> {
    const existing = await hostAccessFor(userId);
    if (existing) {
      throw new DomainError({
        code: 'host.already_host',
        status: 409,
        title: 'You already have a host account',
      });
    }
    const id = uuidv7();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('identity.host_accounts')
        .values({ id, kind: input.kind, display_name: input.displayName, created_by: userId })
        .execute();
      await trx
        .insertInto('identity.host_members')
        .values({ host_account_id: id, user_id: userId, role: 'OWNER' })
        .execute();
      await trx
        .insertInto('identity.role_grants')
        .values({ user_id: userId, role: 'HOST', granted_by: null })
        .onConflict((oc) => oc.columns(['user_id', 'role']).doNothing())
        .execute();
      await audit.record(
        {
          actorKind: 'USER',
          actorId: userId,
          action: 'host.account_created',
          entityKind: 'host_account',
          entityId: id,
          metadata: { kind: input.kind },
          requestId,
        },
        trx,
      );
    });
    return (await hostAccessFor(userId)) as HostAccess;
  }

  /** For admin flows that reference a host by account ID (e.g. society membership). */
  async function hostAccountExists(hostAccountId: string): Promise<boolean> {
    const row = await db
      .selectFrom('identity.host_accounts')
      .select('id')
      .where('id', '=', hostAccountId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Account status by id (payouts only go to ACTIVE hosts). */
  async function hostAccountStatus(
    hostAccountId: string,
  ): Promise<'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | null> {
    const row = await db
      .selectFrom('identity.host_accounts')
      .select('status')
      .where('id', '=', hostAccountId)
      .executeTakeFirst();
    return (row?.status as 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | undefined) ?? null;
  }

  return { hostAccessFor, becomeHost, hostAccountExists, hostAccountStatus };
}

export type HostService = ReturnType<typeof createHostService>;
