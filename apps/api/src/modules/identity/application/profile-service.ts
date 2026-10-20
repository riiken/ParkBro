import type { Kysely } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import type { AdminPermission, Role } from '../../../platform/auth/actor.ts';
import type { FieldCipher } from '../../../platform/crypto/field-cipher.ts';
import { errors } from '../../../platform/errors/domain-error.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import { maskPhone, normalizeIndianMobile } from '../domain/phone.ts';
import { generateTotpSecret, otpauthUri } from '../domain/totp.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';
import { TOTP_CIPHER_CONTEXT, type AuthService } from './auth-service.ts';

export const LOCALES = ['en', 'hi', 'kn'] as const;
export type Locale = (typeof LOCALES)[number];

export function createProfileService(deps: {
  db: Kysely<IdentityDb>;
  audit: AuditLog;
  cipher: FieldCipher;
  auth: AuthService;
}) {
  const { db, audit } = deps;

  async function getProfile(userId: string) {
    const user = await db
      .selectFrom('identity.users')
      .select(['id', 'display_name', 'phone_last4', 'locale', 'created_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw errors.notFound();
    const roles = await db
      .selectFrom('identity.role_grants')
      .select('role')
      .where('user_id', '=', userId)
      .orderBy('role')
      .execute();
    return {
      id: user.id,
      displayName: user.display_name,
      phoneMasked: maskPhone(user.phone_last4),
      locale: user.locale as Locale,
      roles: roles.map((r) => r.role as Role),
      createdAt: user.created_at,
    };
  }

  async function updateProfile(
    userId: string,
    changes: { displayName?: string | undefined; locale?: Locale | undefined },
    requestId: string,
  ) {
    const set = {
      ...(changes.displayName === undefined ? {} : { display_name: changes.displayName }),
      ...(changes.locale === undefined ? {} : { locale: changes.locale }),
    };
    if (Object.keys(set).length > 0) {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable('identity.users').set(set).where('id', '=', userId).execute();
        await audit.record(
          {
            actorKind: 'USER',
            actorId: userId,
            action: 'user.profile_updated',
            entityKind: 'user',
            entityId: userId,
            metadata: { fields: Object.keys(set).join(',') }, // field names only, never values
            requestId,
          },
          trx,
        );
      });
    }
    return getProfile(userId);
  }

  async function getAdminProfile(userId: string) {
    const profile = await getProfile(userId);
    const permissions = await db
      .selectFrom('identity.admin_permissions')
      .select('permission')
      .where('user_id', '=', userId)
      .orderBy('permission')
      .execute();
    return { ...profile, permissions: permissions.map((p) => p.permission as AdminPermission) };
  }

  /**
   * Bootstrap / grant platform admin (CLI only until the admin console exists, Phase 20).
   * The user must already be registered. Returns an otpauth URI the first time MFA is enrolled.
   */
  async function grantPlatformAdmin(input: {
    phone: string;
    permissions: AdminPermission[];
    grantedBy: string | null;
  }) {
    const phoneE164 = normalizeIndianMobile(input.phone);
    if (!phoneE164) throw new Error('invalid phone number');
    const user = await db
      .selectFrom('identity.users')
      .select(['id', 'status'])
      .where('phone_hmac', '=', deps.auth.phoneIndex(phoneE164))
      .executeTakeFirst();
    if (!user) throw new Error('no registered user with that phone number (they must sign up first)');
    if (user.status !== 'ACTIVE') throw new Error('user is not active');

    return db.transaction().execute(async (trx) => {
      await trx
        .insertInto('identity.role_grants')
        .values({ user_id: user.id, role: 'PLATFORM_ADMIN', granted_by: input.grantedBy })
        .onConflict((oc) => oc.columns(['user_id', 'role']).doNothing())
        .execute();
      for (const permission of input.permissions) {
        await trx
          .insertInto('identity.admin_permissions')
          .values({ user_id: user.id, permission, granted_by: input.grantedBy })
          .onConflict((oc) => oc.columns(['user_id', 'permission']).doNothing())
          .execute();
      }
      const mfa = await trx
        .selectFrom('identity.admin_mfa')
        .select('user_id')
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      let enrollmentUri: string | null = null;
      if (!mfa) {
        const secret = generateTotpSecret();
        await trx
          .insertInto('identity.admin_mfa')
          .values({ user_id: user.id, totp_secret_enc: deps.cipher.encrypt(secret, TOTP_CIPHER_CONTEXT) })
          .execute();
        enrollmentUri = otpauthUri(secret, `admin-${phoneE164.slice(-4)}`, 'ParkBro Admin');
      }
      await deps.audit.record(
        {
          actorKind: input.grantedBy ? 'ADMIN' : 'SYSTEM',
          actorId: input.grantedBy,
          action: 'admin.granted',
          entityKind: 'user',
          entityId: user.id,
          metadata: { permissions: input.permissions.join(','), mfaEnrolled: enrollmentUri !== null },
          requestId: `cli-${uuidv7()}`,
        },
        trx,
      );
      return { userId: user.id, enrollmentUri };
    });
  }

  return { getProfile, updateProfile, getAdminProfile, grantPlatformAdmin };
}

export type ProfileService = ReturnType<typeof createProfileService>;
