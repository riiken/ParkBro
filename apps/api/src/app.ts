import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyInstance, type RouteOptions } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Modules } from './composition.ts';
import { systemRoutes, type ReadinessProbe } from './modules/system/index.ts';
import { noSessions, type SessionResolver } from './platform/auth/actor.ts';
import { registerAuthentication } from './platform/auth/authentication.ts';
import type { Env } from './platform/config/env.ts';
import { registerProblemHandlers } from './platform/http/problem.ts';
import { genRequestId } from './platform/http/request-id.ts';
import { registerSecurity } from './platform/http/security.ts';
import { loggerOptions, type LogStream } from './platform/logging/logger.ts';

export const API_PREFIX = '/api';

export interface AppDependencies {
  env: Env;
  readiness: ReadinessProbe;
  /** All feature modules (composition.ts). Identity also provides the session resolver. */
  modules?: Modules;
  /** Overrides the session resolver (unit tests without a database). */
  sessions?: SessionResolver;
  logStream?: LogStream;
  /** Observes every route as it is registered (route-security test). */
  onRoute?: (route: RouteOptions) => void;
  /** Extra routes registered under /api (tests only). */
  extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
}

/**
 * Composition root. The only place that wires platform infrastructure to modules (architecture.md §4).
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { env } = deps;
  const app: FastifyInstance = Fastify({
    logger: loggerOptions(env, deps.logStream),
    genReqId: genRequestId,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true },
  });

  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerProblemHandlers(app);
  registerSecurity(app, { hsts: env.NODE_ENV === 'production' });
  await registerAuthentication(app, deps.sessions ?? deps.modules?.identity.sessionResolver ?? noSessions);

  if (env.API_DOCS_ENABLED) {
    await app.register(swagger, {
      openapi: { openapi: '3.1.0', info: { title: 'ParkBro API', version: '0.1.0' } },
      transform: jsonSchemaTransform,
    });
  }

  await app.register(
    async (api) => {
      await api.register(systemRoutes, { readiness: deps.readiness });
      for (const module of deps.modules?.routeModules ?? []) await module.registerRoutes(api);
      if (env.API_DOCS_ENABLED) {
        api.get('/docs/openapi.json', { schema: { hide: true } }, async () => app.swagger());
      }
      await deps.extraRoutes?.(api);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
