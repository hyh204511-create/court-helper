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

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export interface BuildAppOptions {
  config?: ServerConfig;
  dependencies?: Partial<HealthDependencies>;
  logger?: boolean;
  register?: (app: FastifyInstance) => void | Promise<void>;
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
