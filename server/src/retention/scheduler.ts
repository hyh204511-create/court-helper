import type { Clock } from './policy.ts';
import { RetentionService, type RetentionCleanupResult, type RetentionLogger } from './service.ts';

export const DAILY_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type ScheduleDaily = (task: () => Promise<void>) => () => void;

function defaultScheduleDaily(task: () => Promise<void>): () => void {
  const timer = setInterval(() => {
    void task();
  }, DAILY_RETENTION_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export interface RetentionSchedulerOptions {
  clock?: Clock;
  scheduleDaily?: ScheduleDaily;
  logger?: RetentionLogger;
}

export class RetentionScheduler {
  private readonly cleanupService: Pick<RetentionService, 'cleanup'>;
  private readonly scheduleDaily: ScheduleDaily;
  private readonly logger?: RetentionLogger;
  private started = false;
  private cancelTimer: (() => void) | null = null;

  constructor(
    cleanupService: Pick<RetentionService, 'cleanup'>,
    options: RetentionSchedulerOptions = {},
  ) {
    this.cleanupService = cleanupService;
    this.scheduleDaily = options.scheduleDaily ?? defaultScheduleDaily;
    this.logger = options.logger;
  }

  private async runSafely(): Promise<RetentionCleanupResult | undefined> {
    try {
      return await this.cleanupService.cleanup();
    } catch {
      this.logger?.warn({
        event: 'retention.cleanup_failed',
        failedRuns: 1,
      }, 'Retention cleanup failed');
      return undefined;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.runSafely();
    if (!this.started) return;
    this.cancelTimer = this.scheduleDaily(async () => {
      await this.runSafely();
    });
  }

  async stop(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.started = false;
  }
}
