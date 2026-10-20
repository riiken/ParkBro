import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept an upstream ID (edge / load balancer) only if it is a short, log-safe token.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function genRequestId(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  if (typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}
