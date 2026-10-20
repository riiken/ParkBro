import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { AuditLog } from '../../../platform/audit/audit-log.ts';
import type { FieldCipher } from '../../../platform/crypto/field-cipher.ts';
import type { KeyedHasher } from '../../../platform/crypto/keyed-hash.ts';
import { uuidv7, UUID_PATTERN } from '../../../platform/ids/uuid.ts';
import type { OtpSender } from '../../../platform/providers/otp.ts';
import type { RateLimiter } from '../../../platform/rate-limit/rate-limiter.ts';
import { identityErrors } from '../domain/errors.ts';
import { normalizeIndianMobile } from '../domain/phone.ts';
import {
  ADMIN_TOTP_TICKET_TTL_MINUTES,
  CURRENT_NOTICE_VERSION,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MINUTES,
  RATE_LIMITS,
  REGISTRATION_TICKET_TTL_MINUTES,
  TICKET_MAX_ATTEMPTS,
} from '../domain/policy.ts';
import { verifyTotp } from '../domain/totp.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';
import { createSession, type CreatedSession } from './sessions.ts';

export type OtpPurpose = 'USER_LOGIN' | 'ADMIN_LOGIN';

export interface IdentityDeps {
  db: Kysely<IdentityDb>;
  cipher: FieldCipher;
  hasher: KeyedHasher;
  otpSender: OtpSender;
  generateOtpCode: () => string;
  /** Per-IP OTP send limit per hour (env OTP_SEND_LIMIT_PER_IP_PER_HOUR; default RATE_LIMITS). */
  otpSendLimitPerIpHour?: number | undefined;
  /** Staging allowlist (D-172): when set, codes are sent only to these E.164 numbers. */
  otpAllowedPhones?: ReadonlySet<string> | undefined;
  otpVerifyLimitPerIpHour?: number | undefined;
  rateLimiter: RateLimiter;
  audit: AuditLog;
}

export interface RequestContext {
  ip: string;
  userAgent: string | undefined;
  requestId: string;
}

// Hash purposes (keyed HMAC domains). Changing these invalidates stored hashes.
const PHONE_INDEX = 'identity.phone';
const OTP_CODE = 'identity.otp_code';
const TICKET = 'identity.ticket';
const IP_KEY = 'identity.rate_limit_ip';
/** OTP challenges are ephemeral (database-design §2): removed a week after creation. */
const CHALLENGE_RETENTION_DAYS = 7;
export const PHONE_CIPHER_CONTEXT = 'identity.phone';
export const TOTP_CIPHER_CONTEXT = 'identity.admin_mfa.totp';

export type VerifyResult =
  | { status: 'AUTHENTICATED'; userId: string; session: CreatedSession }
  | { status: 'REGISTRATION_REQUIRED'; ticket: string; ticketExpiresAt: Date }
  | { status: 'TOTP_REQUIRED'; ticket: string; ticketExpiresAt: Date };

function newTicket(challengeId: string) {
  const secret = randomBytes(32).toString('base64url');
  return { ticket: `${challengeId}.${secret}`, secret };
}

function parseTicket(ticket: string): { challengeId: string; secret: string } | null {
  const [challengeId, secret, ...rest] = ticket.split('.');
  if (rest.length > 0 || !challengeId || !secret || !UUID_PATTERN.test(challengeId)) return null;
  return { challengeId, secret };
}

export function createAuthService(deps: IdentityDeps) {
  const { db, cipher, hasher, rateLimiter, audit } = deps;

  function phoneIndex(phoneE164: string): Buffer {
    return hasher.hash(PHONE_INDEX, phoneE164);
  }

  /** Rate-limit keys never contain raw IPs (personal data under DPDP); a keyed hash is enough to count. */
  function ipKey(ip: string): string {
    return hasher.hash(IP_KEY, ip).toString('hex').slice(0, 32);
  }

  async function purgeOldChallenges(): Promise<number> {
    const result = await db
      .deleteFrom('identity.otp_challenges')
      .where(sql<boolean>`created_at < now() - make_interval(days => ${CHALLENGE_RETENTION_DAYS})`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Step 1: send a code. Same response whether or not the number is registered (no account enumeration). */
  async function requestOtp(input: { phone: string; purpose: OtpPurpose }, ctx: RequestContext) {
    const phoneE164 = normalizeIndianMobile(input.phone);
    if (!phoneE164) throw identityErrors.phoneInvalid();
    if (deps.otpAllowedPhones && !deps.otpAllowedPhones.has(phoneE164)) throw identityErrors.inviteOnly();
    const phoneHash = phoneIndex(phoneE164);
    const phoneKey = phoneHash.toString('hex').slice(0, 32);

    await rateLimiter.enforce(
      { key: `otp-send:phone30s:${phoneKey}`, ...RATE_LIMITS.otpSendPerPhone30s },
      { key: `otp-send:phone1h:${phoneKey}`, ...RATE_LIMITS.otpSendPerPhoneHour },
      {
        key: `otp-send:ip1h:${ipKey(ctx.ip)}`,
        windowSeconds: RATE_LIMITS.otpSendPerIpHour.windowSeconds,
        limit: deps.otpSendLimitPerIpHour ?? RATE_LIMITS.otpSendPerIpHour.limit,
      },
    );

    const challengeId = uuidv7();
    const code = deps.generateOtpCode();
    const challenge = await db.transaction().execute(async (trx) => {
      // A new code supersedes earlier unused ones for the same number and purpose.
      await trx
        .updateTable('identity.otp_challenges')
        .set({ status: 'SUPERSEDED' })
        .where('phone_hmac', '=', phoneHash)
        .where('purpose', '=', input.purpose)
        .where('status', '=', 'PENDING')
        .execute();
      return trx
        .insertInto('identity.otp_challenges')
        .values({
          id: challengeId,
          purpose: input.purpose,
          phone_hmac: phoneHash,
          phone_enc: cipher.encrypt(phoneE164, PHONE_CIPHER_CONTEXT),
          code_hash: hasher.hash(OTP_CODE, `${challengeId}:${code}`),
          expires_at: sql<Date>`now() + make_interval(mins => ${OTP_TTL_MINUTES})`,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
    });

    try {
      await deps.otpSender.send({
        phoneE164,
        code,
        purpose: input.purpose,
        expiresInMinutes: OTP_TTL_MINUTES,
      });
    } catch {
      throw identityErrors.deliveryFailed();
    }
    return {
      challengeId: challenge.id,
      expiresAt: challenge.expires_at,
      resendAfterSeconds: RATE_LIMITS.otpSendPerPhone30s.windowSeconds,
    };
  }

  /** Step 2: check the code. Outcomes are computed inside the transaction; errors are thrown after commit. */
  async function verifyOtp(
    input: { challengeId: string; code: string; purpose: OtpPurpose },
    ctx: RequestContext,
  ): Promise<VerifyResult> {
    await rateLimiter.enforce({
      key: `otp-verify:ip1h:${ipKey(ctx.ip)}`,
      ...RATE_LIMITS.otpVerifyPerIpHour,
      limit: deps.otpVerifyLimitPerIpHour ?? RATE_LIMITS.otpVerifyPerIpHour.limit,
    });
    if (!UUID_PATTERN.test(input.challengeId)) throw identityErrors.otpExpired();

    const outcome = await db.transaction().execute(async (trx) => {
      const challenge = await trx
        .selectFrom('identity.otp_challenges')
        .select([
          'id',
          'phone_hmac',
          'code_hash',
          'attempts',
          'status',
          sql<boolean>`expires_at <= now()`.as('expired'),
        ])
        .where('id', '=', input.challengeId)
        .where('purpose', '=', input.purpose)
        .forUpdate()
        .executeTakeFirst();
      if (!challenge || challenge.status !== 'PENDING' || challenge.expired)
        return { error: identityErrors.otpExpired() };

      if (!hasher.verify(OTP_CODE, `${challenge.id}:${input.code}`, challenge.code_hash)) {
        const attempts = challenge.attempts + 1;
        await trx
          .updateTable('identity.otp_challenges')
          .set({ attempts, status: attempts >= OTP_MAX_ATTEMPTS ? 'LOCKED' : 'PENDING' })
          .where('id', '=', challenge.id)
          .execute();
        return { error: identityErrors.otpIncorrect(OTP_MAX_ATTEMPTS - attempts) };
      }

      const user = await trx
        .selectFrom('identity.users')
        .select(['id', 'status'])
        .where('phone_hmac', '=', challenge.phone_hmac)
        .executeTakeFirst();

      if (input.purpose === 'USER_LOGIN') {
        if (user?.status === 'ACTIVE') {
          await consume(trx, challenge.id);
          const session = await createSession(trx, {
            userId: user.id,
            kind: 'USER',
            userAgent: ctx.userAgent,
          });
          await audit.record(
            {
              actorKind: 'USER',
              actorId: user.id,
              action: 'auth.login',
              entityKind: 'session',
              entityId: session.sessionId,
              requestId: ctx.requestId,
            },
            trx,
          );
          return { result: { status: 'AUTHENTICATED', userId: user.id, session } satisfies VerifyResult };
        }
        if (user) {
          await consume(trx, challenge.id);
          return { error: identityErrors.accountSuspended() };
        }
        return {
          result: await issueTicket(
            trx,
            challenge.id,
            REGISTRATION_TICKET_TTL_MINUTES,
            'REGISTRATION_REQUIRED',
          ),
        };
      }

      // ADMIN_LOGIN: the second factor is mandatory; only active platform admins with MFA proceed.
      const admin =
        user?.status === 'ACTIVE'
          ? await trx
              .selectFrom('identity.role_grants as r')
              .innerJoin('identity.admin_mfa as m', 'm.user_id', 'r.user_id')
              .select('r.user_id')
              .where('r.user_id', '=', user.id)
              .where('r.role', '=', 'PLATFORM_ADMIN')
              .executeTakeFirst()
          : undefined;
      if (!admin) {
        await consume(trx, challenge.id);
        return { error: identityErrors.notAdmin() };
      }
      return { result: await issueTicket(trx, challenge.id, ADMIN_TOTP_TICKET_TTL_MINUTES, 'TOTP_REQUIRED') };
    });

    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  async function consume(trx: Kysely<IdentityDb>, challengeId: string) {
    await trx
      .updateTable('identity.otp_challenges')
      .set({ status: 'CONSUMED', ticket_hash: null, ticket_expires_at: null })
      .where('id', '=', challengeId)
      .execute();
  }

  async function issueTicket<S extends 'REGISTRATION_REQUIRED' | 'TOTP_REQUIRED'>(
    trx: Kysely<IdentityDb>,
    challengeId: string,
    ttlMinutes: number,
    status: S,
  ) {
    const { ticket, secret } = newTicket(challengeId);
    const row = await trx
      .updateTable('identity.otp_challenges')
      .set({
        status: 'VERIFIED',
        verified_at: sql<Date>`now()`,
        ticket_hash: hasher.hash(TICKET, secret),
        ticket_expires_at: sql<Date>`now() + make_interval(mins => ${ttlMinutes})`,
      })
      .where('id', '=', challengeId)
      .returning('ticket_expires_at')
      .executeTakeFirstOrThrow();
    return { status, ticket, ticketExpiresAt: row.ticket_expires_at as Date };
  }

  /** Locks a VERIFIED challenge for its follow-up step, counting failed ticket uses. */
  async function lockTicket(trx: Kysely<IdentityDb>, ticket: string, purpose: OtpPurpose) {
    const parsed = parseTicket(ticket);
    if (!parsed) return null;
    const challenge = await trx
      .selectFrom('identity.otp_challenges')
      .select([
        'id',
        'phone_hmac',
        'phone_enc',
        'ticket_hash',
        'ticket_attempts',
        sql<boolean>`ticket_expires_at <= now()`.as('expired'),
      ])
      .where('id', '=', parsed.challengeId)
      .where('purpose', '=', purpose)
      .where('status', '=', 'VERIFIED')
      .forUpdate()
      .executeTakeFirst();
    if (!challenge?.ticket_hash || challenge.expired) return null;
    if (!hasher.verify(TICKET, parsed.secret, challenge.ticket_hash)) return null;
    return challenge;
  }

  /** Step 3 (new users): create the account. Requires 18+ attestation and the current notice version. */
  async function register(
    input: { ticket: string; displayName: string; acceptedNoticeVersion: string },
    ctx: RequestContext,
  ): Promise<{ userId: string; session: CreatedSession }> {
    if (input.acceptedNoticeVersion !== CURRENT_NOTICE_VERSION) throw identityErrors.noticeVersionMismatch();

    const outcome = await db.transaction().execute(async (trx) => {
      const challenge = await lockTicket(trx, input.ticket, 'USER_LOGIN');
      if (!challenge) return { error: identityErrors.ticketInvalid() };
      await consume(trx, challenge.id);

      const phoneE164 = cipher.decrypt(challenge.phone_enc, PHONE_CIPHER_CONTEXT);
      const userId = uuidv7();
      const inserted = await trx
        .insertInto('identity.users')
        .values({
          id: userId,
          phone_enc: cipher.encrypt(phoneE164, PHONE_CIPHER_CONTEXT),
          phone_hmac: challenge.phone_hmac,
          phone_last4: phoneE164.slice(-4),
          display_name: input.displayName,
          age_attested_at: sql<Date>`now()`,
        })
        .onConflict((oc) => oc.column('phone_hmac').doNothing())
        .returning('id')
        .executeTakeFirst();

      if (!inserted) {
        // The number was registered meanwhile (another device): the phone is verified, so sign in instead.
        const existing = await trx
          .selectFrom('identity.users')
          .select(['id', 'status'])
          .where('phone_hmac', '=', challenge.phone_hmac)
          .executeTakeFirstOrThrow();
        if (existing.status !== 'ACTIVE') return { error: identityErrors.accountSuspended() };
        const session = await createSession(trx, {
          userId: existing.id,
          kind: 'USER',
          userAgent: ctx.userAgent,
        });
        return { result: { userId: existing.id, session } };
      }

      await trx
        .insertInto('identity.role_grants')
        .values({ user_id: userId, role: 'CUSTOMER', granted_by: null })
        .execute();
      await trx
        .insertInto('identity.consents')
        .values([
          { id: uuidv7(), user_id: userId, purpose: 'TERMS', notice_version: CURRENT_NOTICE_VERSION },
          { id: uuidv7(), user_id: userId, purpose: 'PRIVACY', notice_version: CURRENT_NOTICE_VERSION },
        ])
        .execute();
      const session = await createSession(trx, { userId, kind: 'USER', userAgent: ctx.userAgent });
      await audit.record(
        {
          actorKind: 'USER',
          actorId: userId,
          action: 'user.registered',
          entityKind: 'user',
          entityId: userId,
          metadata: { noticeVersion: CURRENT_NOTICE_VERSION },
          requestId: ctx.requestId,
        },
        trx,
      );
      return { result: { userId, session } };
    });

    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  /** Admin step 3: TOTP second factor, then an ADMIN session. */
  async function verifyAdminTotp(
    input: { ticket: string; code: string },
    ctx: RequestContext,
  ): Promise<{ userId: string; session: CreatedSession }> {
    const outcome = await db.transaction().execute(async (trx) => {
      const challenge = await lockTicket(trx, input.ticket, 'ADMIN_LOGIN');
      if (!challenge) return { error: identityErrors.ticketInvalid() };

      const admin = await trx
        .selectFrom('identity.users as u')
        .innerJoin('identity.admin_mfa as m', 'm.user_id', 'u.id')
        .innerJoin('identity.role_grants as r', (join) =>
          join.onRef('r.user_id', '=', 'u.id').on('r.role', '=', 'PLATFORM_ADMIN'),
        )
        .select(['u.id', 'm.totp_secret_enc', 'm.last_used_step'])
        .where('u.phone_hmac', '=', challenge.phone_hmac)
        .where('u.status', '=', 'ACTIVE')
        .forUpdate()
        .executeTakeFirst();
      if (!admin) {
        await consume(trx, challenge.id);
        return { error: identityErrors.notAdmin() };
      }

      const limit = await rateLimiter.hit({ key: `totp:user1h:${admin.id}`, ...RATE_LIMITS.totpPerUserHour });
      const step = limit.allowed
        ? verifyTotp({
            secretBase32: cipher.decrypt(admin.totp_secret_enc, TOTP_CIPHER_CONTEXT),
            code: input.code,
            unixSeconds: Math.floor(Date.now() / 1000),
            lastUsedStep: Number(admin.last_used_step),
          })
        : null;

      if (step === null) {
        const attempts = challenge.ticket_attempts + 1;
        await trx
          .updateTable('identity.otp_challenges')
          .set(
            attempts >= TICKET_MAX_ATTEMPTS
              ? { ticket_attempts: attempts, status: 'LOCKED', ticket_hash: null, ticket_expires_at: null }
              : { ticket_attempts: attempts },
          )
          .where('id', '=', challenge.id)
          .execute();
        await audit.record(
          {
            actorKind: 'USER',
            actorId: admin.id,
            action: 'admin.totp_failed',
            entityKind: 'user',
            entityId: admin.id,
            requestId: ctx.requestId,
          },
          trx,
        );
        return { error: identityErrors.totpIncorrect() };
      }

      await trx
        .updateTable('identity.admin_mfa')
        .set({ last_used_step: step })
        .where('user_id', '=', admin.id)
        .execute();
      await consume(trx, challenge.id);
      const session = await createSession(trx, { userId: admin.id, kind: 'ADMIN', userAgent: ctx.userAgent });
      await audit.record(
        {
          actorKind: 'ADMIN',
          actorId: admin.id,
          action: 'admin.login',
          entityKind: 'session',
          entityId: session.sessionId,
          requestId: ctx.requestId,
        },
        trx,
      );
      return { result: { userId: admin.id, session } };
    });

    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  return { requestOtp, verifyOtp, register, verifyAdminTotp, phoneIndex, purgeOldChallenges };
}

export type AuthService = ReturnType<typeof createAuthService>;
