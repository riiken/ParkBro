import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { AnyKyselyExecutor } from '../../platform/audit/audit-log.ts';
import type { SessionResolver } from '../../platform/auth/actor.ts';
import { createAuthService, PHONE_CIPHER_CONTEXT, type IdentityDeps } from './application/auth-service.ts';
import { createHostService, type HostService } from './application/host-service.ts';
import { createProfileService } from './application/profile-service.ts';
import { databaseSessionResolver } from './application/sessions.ts';
import { identityAdminConsoleRoutes } from './http/admin-console-routes.ts';
import { adminIdentityRoutes } from './http/admin-routes.ts';
import { hostRoutes } from './http/host-routes.ts';
import { identityRoutes } from './http/routes.ts';
import type { IdentityDb } from './infrastructure/tables.ts';

export { normalizeIndianMobile } from './domain/phone.ts';
export { base32Decode, hotp, totpStep } from './domain/totp.ts';
export { TOTP_CIPHER_CONTEXT } from './application/auth-service.ts';
export { CURRENT_NOTICE_VERSION } from './domain/policy.ts';
export type { IdentityDb } from './infrastructure/tables.ts';
export type { HostAccess, HostService } from './application/host-service.ts';
export { requireHostAccess } from './application/host-guard.ts';

export interface IdentityModule {
  sessionResolver: SessionResolver;
  registerRoutes(api: FastifyInstance): Promise<void>;
  grantPlatformAdmin: ReturnType<typeof createProfileService>['grantPlatformAdmin'];
  /** Host access lookups for other modules (properties, assets) to authorise host actions. */
  hosts: HostService;
  /** "Priya S.": the customer name a host sees for a booking (trust-and-safety §11). */
  customerNameForHost(userId: string): Promise<string>;
  /** Contact details for the messaging worker only (decrypted at send time, never stored elsewhere). */
  contactFor(
    userId: string,
  ): Promise<{ phoneE164: string | null; email: string | null; locale: string; active: boolean } | null>;
  /** User ids of a host account's members (owner and managers), on the caller's transaction when given. */
  hostMemberIds(hostAccountId: string, executor?: AnyKyselyExecutor): Promise<string[]>;
  /** Job: delete OTP challenges past retention. */
  purgeOldChallenges(): Promise<number>;
}

/** Identity & authorisation (Phase 8): OTP sign-in, registration, sessions, profile, roles, admin MFA. */
export function createIdentityModule<DB>(
  deps: Omit<IdentityDeps, 'db'> & { db: Kysely<DB> },
): IdentityModule {
  const db = deps.db.withTables<IdentityDb>() as unknown as Kysely<IdentityDb>;
  const auth = createAuthService({ ...deps, db });
  const profiles = createProfileService({ db, audit: deps.audit, cipher: deps.cipher, auth });
  const hosts = createHostService({ db, audit: deps.audit });
  return {
    sessionResolver: databaseSessionResolver(db),
    async registerRoutes(api) {
      await api.register(identityRoutes, { auth, profiles, db });
      await api.register(adminIdentityRoutes, { prefix: '/admin', auth, profiles, db });
      await api.register(identityAdminConsoleRoutes, { prefix: '/admin', db, auth, audit: deps.audit });
      await api.register(hostRoutes, { hosts });
    },
    grantPlatformAdmin: profiles.grantPlatformAdmin,
    hosts,
    purgeOldChallenges: auth.purgeOldChallenges,
    async contactFor(userId) {
      const row = await db
        .selectFrom('identity.users')
        .select(['phone_enc', 'locale', 'status'])
        .where('id', '=', userId)
        .executeTakeFirst();
      if (!row) return null;
      return {
        phoneE164: row.status === 'CLOSED' ? null : deps.cipher.decrypt(row.phone_enc, PHONE_CIPHER_CONTEXT),
        email: null, // V-EMAIL is not built yet (Phase 8 deferral)
        locale: row.locale,
        active: row.status === 'ACTIVE',
      };
    },
    async hostMemberIds(hostAccountId, executor) {
      const rows = await ((executor as unknown as Kysely<IdentityDb> | undefined) ?? db)
        .selectFrom('identity.host_members')
        .select('user_id')
        .where('host_account_id', '=', hostAccountId)
        .execute();
      return rows.map((r) => r.user_id);
    },
    async customerNameForHost(userId) {
      const row = await db
        .selectFrom('identity.users')
        .select('display_name')
        .where('id', '=', userId)
        .executeTakeFirst();
      const parts = (row?.display_name ?? 'Customer').trim().split(/\s+/);
      const first = parts[0] ?? 'Customer';
      const last = parts.length > 1 ? parts.at(-1) : undefined;
      return last ? `${first} ${last[0]?.toUpperCase()}.` : first;
    },
  };
}
