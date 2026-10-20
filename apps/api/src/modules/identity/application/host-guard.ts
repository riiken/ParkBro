import type { FastifyRequest } from 'fastify';
import { actorOf } from '../../../platform/auth/authentication.ts';
import { DomainError } from '../../../platform/errors/domain-error.ts';
import type { HostAccess, HostService } from './host-service.ts';

export const notAHost = () =>
  new DomainError({
    code: 'host.not_a_host',
    status: 403,
    title: 'Create a host account first',
    detail: 'Become a host to list a space.',
  });

export const hostRestricted = () =>
  new DomainError({
    code: 'host.restricted',
    status: 403,
    title: 'Your host account is restricted',
    detail: 'Contact support.',
  });

/**
 * Resolves the caller's host account for host-only routes. Writes additionally require an ACTIVE account
 * (restricted/suspended hosts keep read access to their data).
 */
export async function requireHostAccess(
  hosts: HostService,
  request: FastifyRequest,
  options: { forWrite: boolean },
): Promise<HostAccess & { userId: string }> {
  const actor = actorOf(request);
  const access = await hosts.hostAccessFor(actor.userId);
  if (!access) throw notAHost();
  if (options.forWrite && access.status !== 'ACTIVE') throw hostRestricted();
  return { ...access, userId: actor.userId };
}
