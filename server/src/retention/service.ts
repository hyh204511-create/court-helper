import type { AuthRepository } from '../auth/types.ts';
import type {
  CaseRecord,
  CaseRepository,
  ExpiredCaseCursor,
} from '../cases/types.ts';
import type {
  ReportExportCursor,
  ReportExportRecord,
  ReportExportRepository,
} from '../report-exports/types.ts';
import type {
  ImportBatchCursor,
  ImportBatchRecord,
  ImportBatchRepository,
} from '../import-batches/types.ts';
import type { ScreenshotRecord, ScreenshotRepository } from '../screenshots/types.ts';
import type { StorageBackend } from '../storage/types.ts';
import { retentionCutoff } from './policy.ts';
import type { Clock } from './policy.ts';

export interface RetentionDependencies {
  authRepository: AuthRepository;
  caseRepository: CaseRepository;
  reportExportRepository: ReportExportRepository;
  importBatchRepository?: ImportBatchRepository;
  screenshotRepository: ScreenshotRepository;
  storageBackend: StorageBackend;
}

export interface RetentionLogger {
  warn(object: Record<string, unknown>, message?: string): void;
}

export interface RetentionCleanupResult {
  cutoff: Date;
  candidateCases: number;
  deletedCases: number;
  deletedScreenshots: number;
  deletedObjects: number;
  deletedReportExports: number;
  deletedImportBatches: number;
  deletedSessions: number;
  failedObjects: number;
  failedScreenshots: number;
  failedCases: number;
  failedReportExports: number;
  failedImportBatches: number;
  failedSessions: number;
}

const silentLogger: RetentionLogger = { warn() {} };
export const RETENTION_BATCH_SIZE = 100;

function isMissingObjectError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : '';
  return (
    code === 'enoent'
    || code === 'nosuchkey'
    || code === 'nosuchobject'
    || code === 'notfound'
    || code === 'object_not_found'
    || candidate?.status === 404
    || candidate?.statusCode === 404
  );
}

function emptyResult(cutoff: Date): RetentionCleanupResult {
  return {
    cutoff,
    candidateCases: 0,
    deletedCases: 0,
    deletedScreenshots: 0,
    deletedObjects: 0,
    deletedReportExports: 0,
    deletedImportBatches: 0,
    deletedSessions: 0,
    failedObjects: 0,
    failedScreenshots: 0,
    failedCases: 0,
    failedReportExports: 0,
    failedImportBatches: 0,
    failedSessions: 0,
  };
}

export class RetentionService {
  private readonly dependencies: RetentionDependencies;
  private readonly clock: Clock;
  private readonly logger: RetentionLogger;

  constructor(
    dependencies: RetentionDependencies,
    options: { clock?: Clock; logger?: RetentionLogger } = {},
  ) {
    this.dependencies = dependencies;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  private warnIfIncomplete(result: RetentionCleanupResult): void {
    if (
      result.failedObjects === 0
      && result.failedScreenshots === 0
      && result.failedCases === 0
      && result.failedReportExports === 0
      && result.failedImportBatches === 0
      && result.failedSessions === 0
    ) return;

    this.logger.warn({
      event: 'retention.cleanup_incomplete',
      candidateCases: result.candidateCases,
      deletedCases: result.deletedCases,
      deletedScreenshots: result.deletedScreenshots,
      deletedObjects: result.deletedObjects,
      deletedReportExports: result.deletedReportExports,
      deletedImportBatches: result.deletedImportBatches,
      deletedSessions: result.deletedSessions,
      failedObjects: result.failedObjects,
      failedScreenshots: result.failedScreenshots,
      failedCases: result.failedCases,
      failedReportExports: result.failedReportExports,
      failedImportBatches: result.failedImportBatches,
      failedSessions: result.failedSessions,
    }, 'Retention cleanup incomplete');
  }

  private async deleteScreenshot(
    screenshot: ScreenshotRecord,
    result: RetentionCleanupResult,
  ): Promise<boolean> {
    try {
      await this.dependencies.storageBackend.delete(screenshot.objectKey);
      result.deletedObjects += 1;
    } catch (error) {
      if (!isMissingObjectError(error)) {
        result.failedObjects += 1;
        return false;
      }
    }

    try {
      await this.dependencies.screenshotRepository.delete(screenshot.id);
      result.deletedScreenshots += 1;
      return true;
    } catch {
      result.failedScreenshots += 1;
      return false;
    }
  }

  private async deleteCase(caseValue: CaseRecord, result: RetentionCleanupResult): Promise<void> {
    let screenshots: ScreenshotRecord[];
    try {
      screenshots = await this.dependencies.screenshotRepository.listByCaseId(caseValue.id);
    } catch {
      result.failedScreenshots += 1;
      return;
    }

    let readyForCaseDelete = true;
    for (const screenshot of screenshots) {
      const deleted = await this.deleteScreenshot(screenshot, result);
      if (!deleted) readyForCaseDelete = false;
    }
    if (!readyForCaseDelete) return;

    try {
      await this.dependencies.caseRepository.delete(caseValue.id);
      result.deletedCases += 1;
    } catch {
      result.failedCases += 1;
    }
  }

  private async deleteReportExport(
    reportExport: ReportExportRecord,
    result: RetentionCleanupResult,
  ): Promise<void> {
    try {
      await this.dependencies.storageBackend.delete(reportExport.objectKey);
      result.deletedObjects += 1;
    } catch (error) {
      if (!isMissingObjectError(error)) {
        result.failedObjects += 1;
        return;
      }
    }

    try {
      await this.dependencies.reportExportRepository.delete(reportExport.id);
      result.deletedReportExports += 1;
    } catch {
      result.failedReportExports += 1;
    }
  }

  private async cleanupReportExports(
    cutoff: Date,
    result: RetentionCleanupResult,
  ): Promise<void> {
    let cursor: ReportExportCursor | undefined;
    while (true) {
      let page;
      try {
        page = await this.dependencies.reportExportRepository.list({
          limit: RETENTION_BATCH_SIZE,
          cursor,
        });
      } catch {
        result.failedReportExports += 1;
        return;
      }

      for (const reportExport of page.items) {
        if (reportExport.createdAt.getTime() < cutoff.getTime()) {
          await this.deleteReportExport(reportExport, result);
        }
      }

      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  private async deleteImportBatch(
    importBatch: ImportBatchRecord,
    result: RetentionCleanupResult,
  ): Promise<void> {
    const repository = this.dependencies.importBatchRepository;
    if (!repository) return;
    try {
      await this.dependencies.storageBackend.delete(importBatch.objectKey);
      result.deletedObjects += 1;
    } catch (error) {
      if (!isMissingObjectError(error)) {
        result.failedObjects += 1;
        return;
      }
    }

    try {
      await repository.delete(importBatch.id);
      result.deletedImportBatches += 1;
    } catch {
      result.failedImportBatches += 1;
    }
  }

  private async cleanupImportBatches(
    now: Date,
    result: RetentionCleanupResult,
  ): Promise<void> {
    const repository = this.dependencies.importBatchRepository;
    if (!repository) return;

    let cursor: ImportBatchCursor | undefined;
    while (true) {
      let page;
      try {
        page = await repository.list({
          limit: RETENTION_BATCH_SIZE,
          cursor,
        });
      } catch {
        result.failedImportBatches += 1;
        return;
      }

      for (const importBatch of page.items) {
        if (importBatch.expiresAt.getTime() < now.getTime()) {
          await this.deleteImportBatch(importBatch, result);
        }
      }

      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  async cleanup(): Promise<RetentionCleanupResult> {
    const now = new Date(this.clock());
    const result = emptyResult(retentionCutoff(now));

    let cursor: ExpiredCaseCursor | undefined;
    while (true) {
      let page;
      try {
        page = await this.dependencies.caseRepository.listExpired(
          result.cutoff,
          RETENTION_BATCH_SIZE,
          cursor,
        );
      } catch {
        result.failedCases += 1;
        this.warnIfIncomplete(result);
        return result;
      }
      result.candidateCases += page.items.length;
      await Promise.all(page.items.map((caseValue) => this.deleteCase(caseValue, result)));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    await this.cleanupReportExports(result.cutoff, result);
    await this.cleanupImportBatches(now, result);

    try {
      result.deletedSessions = await this.dependencies.authRepository.deleteExpiredOrRevokedSessions(now);
    } catch {
      result.failedSessions += 1;
    }

    this.warnIfIncomplete(result);
    return result;
  }
}
