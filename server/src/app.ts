import fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

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
import { registerLoginCommandRoutes } from './login-commands/routes.ts';
import { LoginCommandService } from './login-commands/service.ts';
import type { LoginCommandRepository } from './login-commands/types.ts';
import { registerCaseRoutes } from './cases/routes.ts';
import { CaseService } from './cases/service.ts';
import type { CaseRepository } from './cases/types.ts';
import { registerScreenshotRoutes } from './screenshots/routes.ts';
import { MAX_SCREENSHOT_BYTES, ScreenshotService } from './screenshots/service.ts';
import type { ScreenshotRepository } from './screenshots/types.ts';
import { registerReportExportRoutes } from './report-exports/routes.ts';
import { MAX_REPORT_EXPORT_BYTES, ReportExportService } from './report-exports/service.ts';
import type { ReportExportRepository } from './report-exports/types.ts';
import type { StorageBackend } from './storage/types.ts';
import {
  RetentionScheduler,
  RetentionService,
  type RetentionLogger,
  type ScheduleDaily,
} from './retention/index.ts';
import type { Clock } from './retention/policy.ts';
import { registerAdminRoutes } from './admin/routes.ts';

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
  loginCommandRepository?: LoginCommandRepository;
  caseRepository?: CaseRepository;
  screenshotRepository?: ScreenshotRepository;
  reportExportRepository?: ReportExportRepository;
  storageBackend?: StorageBackend;
  clock?: Clock;
  retention?: {
    scheduleDaily?: ScheduleDaily;
    logger?: RetentionLogger;
  };
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

const defaultRetentionLogger: RetentionLogger = {
  warn(object, message) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', message, ...object })}\n`);
  },
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? (() => new Date());
  const dependencies: HealthDependencies = {
    database: options.dependencies?.database ?? unavailableDependency,
    objectStorage: options.dependencies?.objectStorage ?? options.storageBackend ?? unavailableDependency,
  };
  const maxMultipartFileBytes = Math.max(MAX_SCREENSHOT_BYTES, MAX_REPORT_EXPORT_BYTES);
  const app = fastify({
    logger: options.logger ?? false,
    bodyLimit: maxMultipartFileBytes + 1024 * 1024,
  });

  app.register(cookie);
  app.register(multipart, {
    throwFileSizeLimit: false,
    limits: {
      fileSize: maxMultipartFileBytes,
      files: 1,
      fields: 4,
      parts: 5,
    },
  });
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
    registerAdminRoutes(app, { authService });
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
    if (options.loginCommandRepository) {
      const loginCommandService = new LoginCommandService(options.loginCommandRepository, { now: clock });
      registerLoginCommandRoutes(app, {
        config,
        prefix: '',
        authService,
        service: loginCommandService,
      });
      registerLoginCommandRoutes(app, {
        config,
        prefix: '/api/v1',
        authService,
        service: loginCommandService,
      });
    }
    if (options.caseRepository && options.platformAccountRepository) {
      const caseService = new CaseService(options.caseRepository, options.platformAccountRepository, clock);
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
    if (options.caseRepository && options.screenshotRepository && options.storageBackend) {
      const screenshotService = new ScreenshotService(
        options.screenshotRepository,
        options.caseRepository,
        options.storageBackend,
        clock,
      );
      registerScreenshotRoutes(app, {
        authService,
        config,
        prefix: '',
        service: screenshotService,
      });
      registerScreenshotRoutes(app, {
        authService,
        config,
        prefix: '/api/v1',
        service: screenshotService,
      });
    }
    if (options.reportExportRepository && options.storageBackend) {
      const reportExportService = new ReportExportService(
        options.reportExportRepository,
        options.storageBackend,
        clock,
      );
      registerReportExportRoutes(app, {
        authService,
        config,
        prefix: '',
        service: reportExportService,
      });
      registerReportExportRoutes(app, {
        authService,
        config,
        prefix: '/api/v1',
        service: reportExportService,
      });
    }

    if (
      options.caseRepository
      && options.reportExportRepository
      && options.screenshotRepository
      && options.storageBackend
    ) {
      const retentionLogger = options.retention?.logger
        ?? (options.logger ? app.log : defaultRetentionLogger);
      const retentionService = new RetentionService({
        authRepository: options.authRepository,
        caseRepository: options.caseRepository,
        reportExportRepository: options.reportExportRepository,
        screenshotRepository: options.screenshotRepository,
        storageBackend: options.storageBackend,
      }, {
        clock,
        logger: retentionLogger,
      });
      const retentionScheduler = new RetentionScheduler(retentionService, {
        scheduleDaily: options.retention?.scheduleDaily,
        logger: retentionLogger,
      });
      app.addHook('onListen', () => {
        void retentionScheduler.start().catch(() => {
          retentionLogger.warn({
            event: 'retention.scheduler_start_failed',
          }, 'Retention scheduler start failed');
        });
      });
      app.addHook('onClose', async () => {
        await retentionScheduler.stop();
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
