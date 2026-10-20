export const ROLES = ['CUSTOMER', 'HOST', 'PROPERTY_ADMIN', 'PLATFORM_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ADMIN_PERMISSIONS = ['SUPPORT', 'TRUST_SAFETY', 'FINANCE', 'SUPER_ADMIN'] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export type SessionKind = 'USER' | 'ADMIN';

export interface AuthenticatedActor {
  kind: 'user';
  userId: string;
  sessionId: string;
  sessionKind: SessionKind;
  roles: readonly Role[];
  /** Admin permissions; always empty for USER sessions (admin powers need an ADMIN session). */
  permissions: readonly AdminPermission[];
}

export type Actor = { kind: 'anonymous' } | AuthenticatedActor;

export const ANONYMOUS: Actor = Object.freeze({ kind: 'anonymous' });

/**
 * Looks up a session by token hash. Implemented by the identity module (Phase 8).
 * Must return null for unknown, expired or revoked sessions, and for a session of the wrong kind.
 */
export interface SessionResolver {
  resolve(tokenHash: Buffer, kind: SessionKind): Promise<AuthenticatedActor | null>;
}

/** Phase 7 default: no sessions exist yet, so every request is anonymous. */
export const noSessions: SessionResolver = {
  resolve: async () => null,
};
