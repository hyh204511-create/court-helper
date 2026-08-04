import fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';

import { loadConfig, type ServerConfig } from './config.ts';
import { errorEnvelope, errorFromFastify, NotFoundError } from './errors.ts';
import {
  registerHealthRoutes,
  unavailableDependency,
  type HealthDependencies,
} from './health.ts';
import { attachRequestId } from './request-id.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { AuthService } from './auth/service.ts';
import type { AuthContext } from './auth/service.ts';
import type { AuthRepository } from './auth/types.ts';
import { registerPlatformAccountRoutes } from './platform-accounts/routes.ts';
import { PlatformAccountService } from './platform-accounts/service.ts';
import type { PlatformAccountRepository } from './platform-accounts/types.ts';
import { registerCaseRoutes } from './cases/routes.ts';
import { CaseService } from './cases/service.ts';
import type { CaseRepository } from './cases/types.ts';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    auth: AuthContext | null;
  }
}

export interface BuildAppOptions {
  config?: ServerConfig;
  dependencies?: Partial<HealthDependencies>;
  logger?: boolean;
  register?: (app: FastifyInstance) => void | Promise<void>;
  authRepository?: AuthRepository;
  platformAccountRepository?: PlatformAccountRepository;
  caseRepository?: CaseRepository;
}

function registerCors(app: FastifyInstance, config: ServerConfig): void {
  app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, config.cors.allowedOrigins.includes(origin));
    },
  });
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const dependencies: HealthDependencies = {
    database: options.dependencies?.database ?? unavailableDependency,
    objectStorage: options.dependencies?.objectStorage ?? unavailableDependency,
  };
  const app = fastify({ logger: options.logger ?? false });

  app.register(cookie);
  registerCors(app, config);
  app.decorateRequest('requestId', '');
  if (options.authRepository) {
    app.decorateRequest('auth', null);
  }
  app.addHook('onRequest', attachRequestId);

  app.setErrorHandler((error, request, reply) => {
    const normalized = errorFromFastify(error);
    reply
      .code(normalized.statusCode)
      .send(errorEnvelope(normalized, request.requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError();
    reply.code(error.statusCode).send(errorEnvelope(error, request.requestId));
  });

  registerHealthRoutes(app, '', dependencies);
  registerHealthRoutes(app, '/api/v1', dependencies);

  if (options.authRepository) {
    const authService = new AuthService(options.authRepository, config);
    app.addHook('onReady', async () => {
      await authService.seedInitialAdmin();
    });
    registerAuthRoutes(app, {
      config,
      prefix: '',
      repository: options.authRepository,
      service: authService,
    });
    registerAuthRoutes(app, {
      config,
      prefix: '/api/v1',
      repository: options.authRepository,
      service: authService,
    });
    if (options.platformAccountRepository) {
      const platformAccountService = new PlatformAccountService(options.platformAccountRepository, config);
      registerPlatformAccountRoutes(app, {
        config,
        prefix: '',
        authService,
        service: platformAccountService,
      });
      registerPlatformAccountRoutes(app, {
        config,
        prefix: '/api/v1',
        authService,
        service: platformAccountService,
      });
    }
    if (options.caseRepository && options.platformAccountRepository) {
      const caseService = new CaseService(options.caseRepository, options.platformAccountRepository);
      registerCaseRoutes(app, {
        authService,
        prefix: '',
        service: caseService,
      });
      registerCaseRoutes(app, {
        authService,
        prefix: '/api/v1',
        service: caseService,
      });
    }
  }

  if (options.register) {
    app.register(async (instance) => {
      await options.register?.(instance);
    });
  }

  return app;
}

export { AppError } from './errors.ts';
export { loadConfig } from './config.ts';
export type { ServerConfig } from './config.ts';
