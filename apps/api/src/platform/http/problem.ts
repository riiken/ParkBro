import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { ProblemDetails } from '@parkbro/contracts';
import { DomainError } from '../errors/domain-error.ts';
import { RateLimitedError } from '../rate-limit/rate-limiter.ts';

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

// Stable codes for framework-level client errors (body parsing, size limits, media types).
const CLIENT_ERROR_CODES: Record<number, { code: string; title: string }> = {
  400: { code: 'request.malformed', title: 'Malformed request' },
  404: { code: 'resource.not_found', title: 'Not found' },
  405: { code: 'request.method_not_allowed', title: 'Method not allowed' },
  413: { code: 'request.too_large', title: 'Request too large' },
  415: { code: 'request.unsupported_media_type', title: 'Unsupported media type' },
  429: { code: 'request.rate_limited', title: 'Too many requests' },
};

/**
 * Error objects from the framework carry the raw request URL (query strings, path tokens). Log only the
 * fields needed to debug, never the whole object (architecture.md §9 logging hygiene).
 */
function loggable(error: Error & { code?: unknown }) {
  return { type: error.name, code: error.code, message: error.message, stack: error.stack };
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  problem: Omit<ProblemDetails, 'requestId' | 'type'>,
) {
  const body: ProblemDetails = { type: `/problems/${problem.code}`, ...problem, requestId: request.id };
  return reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return send(reply, request, {
        status: 400,
        code: 'request.invalid',
        title: 'Invalid request',
        errors: error.validation.map((issue) => ({
          path: `${error.validationContext ?? 'request'}${issue.instancePath}`,
          message: issue.message ?? 'Invalid value',
        })),
      });
    }

    if (error instanceof RateLimitedError) {
      reply.header('retry-after', String(error.retryAfterSeconds));
    }

    if (error instanceof DomainError) {
      return send(reply, request, {
        status: error.status,
        code: error.code,
        title: error.title,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      });
    }

    if (isResponseSerializationError(error)) {
      // Our own response failed its schema: a server bug, and possibly a data-shaping leak averted.
      request.log.error(
        { err: loggable(error), issues: error.cause.issues },
        'response failed schema validation',
      );
      return send(reply, request, {
        status: 500,
        code: 'internal',
        title: 'Something went wrong on our side',
      });
    }

    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      const known = CLIENT_ERROR_CODES[status] ?? { code: 'request.error', title: 'Request error' };
      return send(reply, request, { status, ...known });
    }

    request.log.error({ err: loggable(error) }, 'unhandled error');
    return send(reply, request, { status: 500, code: 'internal', title: 'Something went wrong on our side' });
  });

  app.setNotFoundHandler((request, reply) =>
    send(reply, request, { status: 404, code: 'route.not_found', title: 'Not found' }),
  );
}
