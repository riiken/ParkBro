/**
 * An expected, user-safe failure with a stable machine-readable `code` (architecture.md §6.6).
 * Thrown by modules; translated to RFC 9457 problem+json by the HTTP error handler.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;

  constructor(options: { code: string; status: number; title: string; detail?: string }) {
    super(options.detail ?? options.title);
    this.name = 'DomainError';
    this.code = options.code;
    this.status = options.status;
    this.title = options.title;
    this.detail = options.detail;
  }
}

export const errors = {
  /** Optimistic concurrency: the client edited an outdated version (database-design §1). */
  stale: () =>
    new DomainError({
      code: 'conflict.stale',
      status: 409,
      title: 'This was changed elsewhere',
      detail: 'Reload to see the latest version, then try again.',
    }),
  unauthenticated: () =>
    new DomainError({ code: 'auth.unauthenticated', status: 401, title: 'Sign in required' }),
  forbidden: () => new DomainError({ code: 'auth.forbidden', status: 403, title: 'Not allowed' }),
  notFound: (detail?: string) =>
    new DomainError({
      code: 'resource.not_found',
      status: 404,
      title: 'Not found',
      ...(detail === undefined ? {} : { detail }),
    }),
};
