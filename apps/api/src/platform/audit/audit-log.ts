import type { Generated, Kysely } from 'kysely';

/**
 * Append-only audit trail for security-relevant and admin actions (database-design.md §10).
 * Metadata must never contain secrets or raw PII (phone numbers, codes, tokens).
 */
export interface AuditEntry {
  actorKind: 'USER' | 'ADMIN' | 'SYSTEM' | 'ANONYMOUS';
  actorId: string | null;
  action: string;
  entityKind: string;
  entityId: string;
  metadata?: Record<string, string | number | boolean | null>;
  requestId?: string;
}

export interface AuditTable {
  id: Generated<string>;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  entity_kind: string;
  entity_id: string;
  metadata: unknown;
  request_id: string | null;
  created_at: Generated<Date>;
}

export type AuditTables = {
  'platform.audit_events': AuditTable;
};

/** Any Kysely instance or transaction, whatever its table registry (every module's DB type includes audit). */
export type AnyKyselyExecutor = Pick<Kysely<AuditTables>, 'isTransaction'>;

export interface AuditLog {
  /** Pass the caller's transaction (of any module's table set) to make the audit row atomic with the change. */
  record(entry: AuditEntry, db?: AnyKyselyExecutor): Promise<void>;
}

export function createAuditLog(defaultDb: Kysely<AuditTables>): AuditLog {
  return {
    async record(entry, db) {
      const executor = (db ?? defaultDb) as unknown as Kysely<AuditTables>;
      await executor
        .insertInto('platform.audit_events')
        .values({
          actor_kind: entry.actorKind,
          actor_id: entry.actorId,
          action: entry.action,
          entity_kind: entry.entityKind,
          entity_id: entry.entityId,
          metadata: JSON.stringify(entry.metadata ?? {}),
          request_id: entry.requestId ?? null,
        })
        .execute();
    },
  };
}
