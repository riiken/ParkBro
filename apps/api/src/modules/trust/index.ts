import type { FastifyInstance } from 'fastify';
import type { ColumnType, Kysely } from 'kysely';
import type { AnyKyselyExecutor, AuditLog } from '../../platform/audit/audit-log.ts';
import { clearanceAdminRoutes } from './clearance-routes.ts';
import { uuidv7 } from '../../platform/ids/uuid.ts';

/**
 * Trust (Phase 9 foundation: verification records and host attestations; trust-and-safety.md §3).
 * Risk signals, flags, restrictions and KYC verifications arrive with the phases that need them.
 */
export type VerificationSubject = 'USER' | 'HOST_ACCOUNT' | 'VEHICLE' | 'PROPERTY' | 'ASSET';
export type VerificationKind =
  'RIGHT_TO_RENT' | 'CHARGER_SAFETY' | 'SOCIETY_CONSENT' | 'PHOTO_REVIEW' | 'SITE_VISIT' | 'PILOT_CLEARANCE';
export type VerificationStatus = 'PENDING' | 'ATTESTED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

/** Exact wording the host accepts; the version is stored with the record (V-RIGHT, V-CHARGER). */
export const ATTESTATIONS = {
  RIGHT_TO_RENT: {
    version: 'right-to-rent-v1',
    text: "I own this space or have the legal right to rent it out, and renting it doesn't break my lease, my society's rules or any law.",
  },
  CHARGER_SAFETY: {
    version: 'charger-safety-v1',
    text: 'The charger was installed by a licensed electrician, is properly earthed and protected (RCD/MCB), and its cable and connector are in good condition. I will not let anyone use extension boards.',
  },
} as const;
export type AttestationKind = keyof typeof ATTESTATIONS;

interface VerificationRecordsTable {
  id: string;
  subject_kind: string;
  subject_id: string;
  kind: string;
  method: string;
  status: string;
  statement_version: string | null;
  actor_id: string;
  note: string | null;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  expires_at: Date | null;
}
type TrustDb = { 'trust.verification_records': VerificationRecordsTable };

export interface TrustModule {
  registerRoutes(api: FastifyInstance): Promise<void>;
  /** Pilot clearance (D-168): true when the latest PILOT_CLEARANCE record for the user is VERIFIED. */
  customerCleared(userId: string): Promise<boolean>;
  attest(
    input: { subjectKind: VerificationSubject; subjectId: string; kind: AttestationKind; actorId: string },
    executor?: AnyKyselyExecutor,
  ): Promise<void>;
  record(
    input: {
      subjectKind: VerificationSubject;
      subjectId: string;
      kind: VerificationKind;
      method: 'ADMIN_REVIEW' | 'DOCUMENT' | 'FIELD_VISIT';
      status: VerificationStatus;
      actorId: string;
      note?: string | undefined;
    },
    executor?: AnyKyselyExecutor,
  ): Promise<void>;
  /** Latest record status per kind for a subject (newest wins). */
  latestStatuses(
    subjectKind: VerificationSubject,
    subjectId: string,
  ): Promise<Partial<Record<VerificationKind, VerificationStatus>>>;
}

export function createTrustModule<DB>(deps: {
  db: Kysely<DB>;
  audit?: AuditLog;
  /** PILOT_CUSTOMER_CLEARANCE: shown to admins; enforcement is the booking module's (composition). */
  clearanceRequired?: boolean;
}): TrustModule {
  const db = deps.db.withTables<TrustDb>() as unknown as Kysely<TrustDb>;
  const exec = (executor?: AnyKyselyExecutor) => (executor as unknown as Kysely<TrustDb> | undefined) ?? db;
  const module: TrustModule = {
    async registerRoutes(api) {
      if (!deps.audit) return;
      await api.register(clearanceAdminRoutes, {
        prefix: '/admin',
        db: db as never,
        audit: deps.audit,
        required: deps.clearanceRequired ?? false,
        record: ({ userId, cleared, actorId, note }) =>
          module.record({
            subjectKind: 'USER',
            subjectId: userId,
            kind: 'PILOT_CLEARANCE',
            method: 'ADMIN_REVIEW',
            status: cleared ? 'VERIFIED' : 'REJECTED',
            actorId,
            note,
          }),
      });
    },
    async customerCleared(userId) {
      return (await module.latestStatuses('USER', userId)).PILOT_CLEARANCE === 'VERIFIED';
    },
    async attest({ subjectKind, subjectId, kind, actorId }, executor) {
      await exec(executor)
        .insertInto('trust.verification_records')
        .values({
          id: uuidv7(),
          subject_kind: subjectKind,
          subject_id: subjectId,
          kind,
          method: 'SELF_ATTESTATION',
          status: 'ATTESTED',
          statement_version: ATTESTATIONS[kind].version,
          actor_id: actorId,
          note: null,
          expires_at: null,
        })
        .execute();
    },
    async record(input, executor) {
      await exec(executor)
        .insertInto('trust.verification_records')
        .values({
          id: uuidv7(),
          subject_kind: input.subjectKind,
          subject_id: input.subjectId,
          kind: input.kind,
          method: input.method,
          status: input.status,
          statement_version: null,
          actor_id: input.actorId,
          note: input.note ?? null,
          expires_at: null,
        })
        .execute();
    },
    async latestStatuses(subjectKind, subjectId) {
      const rows = await db
        .selectFrom('trust.verification_records')
        .select(['kind', 'status'])
        .distinctOn('kind')
        .where('subject_kind', '=', subjectKind)
        .where('subject_id', '=', subjectId)
        .orderBy('kind')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return Object.fromEntries(rows.map((r) => [r.kind, r.status])) as Partial<
        Record<VerificationKind, VerificationStatus>
      >;
    },
  };
  return module;
}
