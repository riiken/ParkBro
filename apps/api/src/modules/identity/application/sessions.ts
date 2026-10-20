import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  AdminPermission,
  AuthenticatedActor,
  Role,
  SessionKind,
  SessionResolver,
} from '../../../platform/auth/actor.ts';
import { generateSessionToken, hashSessionToken } from '../../../platform/auth/session-token.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import { SESSION_POLICY, SESSION_TOUCH_INTERVAL_MINUTES } from '../domain/policy.ts';
import type { IdentityDb } from '../infrastructure/tables.ts';

export interface CreatedSession {
  sessionId: string;
  token: string;
  /** Cookie lifetime: the absolute cap. The server enforces the sliding window. */
  cookieMaxAgeSeconds: number;
}

function lifetimes(kind: SessionKind) {
  if (kind === 'USER') {
    return {
      idle: sql<Date>`now() + make_interval(days => ${SESSION_POLICY.USER.idleDays})`,
      absolute: sql<Date>`now() + make_interval(days => ${SESSION_POLICY.USER.absoluteDays})`,
      idleInterval: sql`make_interval(days => ${SESSION_POLICY.USER.idleDays})`,
      maxAge: SESSION_POLICY.USER.absoluteDays * 86_400,
    };
  }
  return {
    idle: sql<Date>`now() + make_interval(mins => ${SESSION_POLICY.ADMIN.idleMinutes})`,
    absolute: sql<Date>`now() + make_interval(hours => ${SESSION_POLICY.ADMIN.absoluteHours})`,
    idleInterval: sql`make_interval(mins => ${SESSION_POLICY.ADMIN.idleMinutes})`,
    maxAge: SESSION_POLICY.ADMIN.absoluteHours * 3_600,
  };
}

export async function createSession(
  trx: Transaction<IdentityDb> | Kysely<IdentityDb>,
  input: { userId: string; kind: SessionKind; userAgent: string | undefined },
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const life = lifetimes(input.kind);
  const sessionId = uuidv7();
  await trx
    .insertInto('identity.sessions')
    .values({
      id: sessionId,
      user_id: input.userId,
      kind: input.kind,
      token_hash: hashSessionToken(token),
      expires_at: life.idle,
      absolute_expires_at: life.absolute,
      user_agent: input.userAgent?.slice(0, 200) ?? null,
    })
    .execute();
  return { sessionId, token, cookieMaxAgeSeconds: life.maxAge };
}

/** Implements the platform SessionResolver against identity.sessions (Phase 7 interface). */
export function databaseSessionResolver(db: Kysely<IdentityDb>): SessionResolver {
  return {
    async resolve(tokenHash, kind): Promise<AuthenticatedActor | null> {
      const row = await db
        .selectFrom('identity.sessions as s')
        .innerJoin('identity.users as u', 'u.id', 's.user_id')
        .select([
          's.id',
          's.user_id',
          sql<boolean>`s.last_seen_at < now() - make_interval(mins => ${SESSION_TOUCH_INTERVAL_MINUTES})`.as(
            'stale',
          ),
          sql<
            string[]
          >`coalesce((SELECT array_agg(r.role ORDER BY r.role) FROM identity.role_grants r WHERE r.user_id = s.user_id), '{}')`.as(
            'roles',
          ),
          sql<
            string[]
          >`coalesce((SELECT array_agg(p.permission ORDER BY p.permission) FROM identity.admin_permissions p WHERE p.user_id = s.user_id), '{}')`.as(
            'permissions',
          ),
        ])
        .where('s.token_hash', '=', tokenHash)
        .where('s.kind', '=', kind)
        .where('s.revoked_at', 'is', null)
        .where(sql<boolean>`s.expires_at > now() AND s.absolute_expires_at > now()`)
        .where('u.status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (!row) return null;

      const roles = row.roles as Role[];
      // Admin powers only through an ADMIN session of a user who still holds PLATFORM_ADMIN.
      const permissions =
        kind === 'ADMIN' && roles.includes('PLATFORM_ADMIN') ? (row.permissions as AdminPermission[]) : [];
      if (kind === 'ADMIN' && !roles.includes('PLATFORM_ADMIN')) return null;

      if (row.stale) {
        const life = lifetimes(kind);
        await db
          .updateTable('identity.sessions')
          .set({
            last_seen_at: sql<Date>`now()`,
            expires_at: sql<Date>`least(now() + ${life.idleInterval}, absolute_expires_at)`,
          })
          .where('id', '=', row.id)
          .execute();
      }

      return { kind: 'user', userId: row.user_id, sessionId: row.id, sessionKind: kind, roles, permissions };
    },
  };
}

export async function revokeSession(
  db: Kysely<IdentityDb>,
  input: { sessionId: string; userId: string; reason: 'LOGOUT' | 'USER_REVOKED' },
): Promise<boolean> {
  const result = await db
    .updateTable('identity.sessions')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: input.reason })
    .where('id', '=', input.sessionId)
    .where('user_id', '=', input.userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function listActiveSessions(db: Kysely<IdentityDb>, userId: string) {
  return db
    .selectFrom('identity.sessions')
    .select(['id', 'kind', 'created_at', 'last_seen_at', 'user_agent'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where(sql<boolean>`expires_at > now() AND absolute_expires_at > now()`)
    .orderBy('last_seen_at', 'desc')
    .execute();
}
