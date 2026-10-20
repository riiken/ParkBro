import { problemDetailsSchema, type ProblemDetails } from '@parkbro/contracts';

/** A failed API call, carrying the RFC 9457 problem (architecture.md §6.6) for UX error mapping (ux §8.4). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly fieldErrors: Record<string, string>;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(problem: Omit<ProblemDetails, 'type'> & { retryAfterSeconds?: number | undefined }) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.title = problem.title;
    this.detail = problem.detail;
    this.requestId = problem.requestId || undefined;
    this.retryAfterSeconds = problem.retryAfterSeconds;
    this.fieldErrors = Object.fromEntries(
      (problem.errors ?? []).map((e) => [e.path.replace(/^body\//, ''), e.message]),
    );
  }

  /** User-facing text: the server's user-safe detail, else its title. */
  get userMessage(): string {
    return this.detail ? `${this.title}. ${this.detail}` : this.title;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers, e.g. Idempotency-Key. Cannot override the CSRF or content headers. */
  headers?: Record<string, string>;
}

/**
 * Same-origin JSON call to /api (D-033): cookies are first-party, and the CSRF header is always sent.
 * Network failures become an ApiError with code `network.unavailable` so the UI has one error path.
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...options.headers,
        accept: 'application/json',
        'x-requested-with': 'fetch',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError({
      status: 0,
      code: 'network.unavailable',
      title: "Can't reach the server",
      detail: 'Check your connection and try again.',
      requestId: '',
    });
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (response.ok) return data as T;

  const retryAfter = Number(response.headers.get('retry-after'));
  const parsed = problemDetailsSchema.safeParse(data);
  throw new ApiError(
    parsed.success
      ? {
          ...parsed.data,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        }
      : {
          status: response.status,
          code: 'internal',
          title: 'Something went wrong on our side',
          detail: 'Please try again.',
          requestId: response.headers.get('x-request-id') ?? '',
        },
  );
}
