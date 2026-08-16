import type { CaseRepository, CaseStatus } from '../cases/types.ts';
import type { ScreenshotRepository, ScreenshotType } from '../screenshots/types.ts';
import type { WecomNotificationRepository } from '../wecom-notifications/types.ts';

export interface BrowserCommandEvidenceInput {
  platformAccountId: string | null;
  requestedBy: string;
  evidenceEventIds: string[];
}

export type BrowserCommandEvidenceVerifier = (input: BrowserCommandEvidenceInput) => Promise<boolean>;

const TERMINAL = new Set<CaseStatus>(['立案成功', '强执成功', '已驳回']);

function screenshotType(kind: 'li' | 'qz', status: CaseStatus): ScreenshotType {
  if (status === '已驳回') return 'reject';
  return kind === 'qz' ? 'enforcement_success' : 'success';
}

export function createBrowserCommandEvidenceVerifier(
  cases: CaseRepository,
  screenshots: ScreenshotRepository,
  notifications: WecomNotificationRepository,
): BrowserCommandEvidenceVerifier {
  return async ({ platformAccountId, requestedBy, evidenceEventIds }) => {
    if (!platformAccountId || evidenceEventIds.length === 0) return false;
    const expected = new Set(evidenceEventIds);
    if (expected.size !== evidenceEventIds.length) return false;
    const accountCases = await cases.list({ platformAccountId, createdBy: requestedBy, limit: 101 });
    const matched = accountCases.filter((value) => expected.has(value.sourceEventId));
    if (matched.length !== expected.size) return false;

    for (const caseValue of matched) {
      if (caseValue.needsHuman || caseValue.status === 'UNKNOWN') return false;
      if (!TERMINAL.has(caseValue.status)) continue;
      const screenshot = await screenshots.findByCaseIdAndType(
        caseValue.id,
        screenshotType(caseValue.kind, caseValue.status),
      );
      if (!screenshot) return false;
      const records = await notifications.listByCaseId(caseValue.id);
      if (!records.some((record) => (
        record.platformAccountId === platformAccountId
        && record.resultStatus === caseValue.status
        && record.screenshotId === screenshot.id
        && record.status === 'sent'
      ))) return false;
    }
    return true;
  };
}
