import { createHash } from 'node:crypto';

import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../errors.ts';
import { ownerIdFor, type CaseAccess, type CaseRecord, type CaseRepository } from '../cases/types.ts';
import type { PlatformAccountRepository } from '../platform-accounts/types.ts';
import type { ScreenshotRecord, ScreenshotRepository, ScreenshotType } from '../screenshots/types.ts';
import type { StorageBackend } from '../storage/types.ts';
import type { WecomNotificationRecord, WecomNotificationRepository, WecomTerminalStatus } from './types.ts';

export const MAX_WECOM_IMAGE_BYTES = 2 * 1024 * 1024;
const TERMINAL_STATUSES = new Set<WecomTerminalStatus>(['立案成功', '强执成功', '已驳回']);

export interface WecomRepeatEvidenceInput {
  platformAccountId: string | null;
  requestedBy: string;
  evidenceEventIds: string[];
  startedAt: Date;
}

export type WecomPayload =
  | { msgtype: 'image'; image: { base64: string; md5: string } }
  | { msgtype: 'text'; text: { content: string } };
export type WecomTransport = (url: string, payload: WecomPayload) => Promise<{ errcode?: unknown }>;
export type WecomWebhookResolver = (userId: string | null) => Promise<string | undefined>;

function screenshotType(value: CaseRecord): ScreenshotType {
  if (value.status === '已驳回') return 'reject';
  if (value.kind === 'qz') return 'enforcement_success';
  return 'success';
}

function resultText(value: CaseRecord, contactNames: string[]): string {
  const lines = [
    contactNames.map((name) => `@${name}`).join(' '),
    `案件类型：${value.kind === 'qz' ? '强制执行' : '立案'}`,
    `原告：${value.plaintiff || '—'}`,
    `被告：${value.defendant || '—'}`,
    `结果：${value.status}`,
  ];
  if (value.caseNumber) lines.push(`案号：${value.caseNumber}`);
  if (value.rejectReason) lines.push(`相关内容：${value.rejectReason}`);
  if (value.queryTime) lines.push(`查询时间：${value.queryTime.toISOString()}`);
  return lines.join('\n');
}

async function streamBuffer(stream: NodeJS.ReadableStream, expectedBytes: number): Promise<Buffer> {
  if (expectedBytes > MAX_WECOM_IMAGE_BYTES) throw new AppError('WeCom image is too large', 'WECOM_IMAGE_TOO_LARGE', 413, false);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WECOM_IMAGE_BYTES) throw new AppError('WeCom image is too large', 'WECOM_IMAGE_TOO_LARGE', 413, false);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function defaultWecomTransport(url: string, payload: WecomPayload): Promise<{ errcode?: unknown }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('WeCom request failed');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid WeCom response');
  return value as { errcode?: unknown };
}

export class WecomNotificationService {
  private readonly background = new Set<Promise<void>>();
  private readonly webhookUrl: string | undefined;
  private readonly cases: CaseRepository;
  private readonly accounts: PlatformAccountRepository;
  private readonly screenshots: ScreenshotRepository;
  private readonly notifications: WecomNotificationRepository;
  private readonly storage: StorageBackend;
  private readonly transport: WecomTransport;
  private readonly resolveWebhook: WecomWebhookResolver;
  constructor(
    webhookUrl: string | undefined,
    cases: CaseRepository,
    accounts: PlatformAccountRepository,
    screenshots: ScreenshotRepository,
    notifications: WecomNotificationRepository,
    storage: StorageBackend,
    transport: WecomTransport = defaultWecomTransport,
    resolveWebhook?: WecomWebhookResolver,
  ) {
    this.webhookUrl = webhookUrl;
    this.cases = cases;
    this.accounts = accounts;
    this.screenshots = screenshots;
    this.notifications = notifications;
    this.storage = storage;
    this.transport = transport;
    this.resolveWebhook = resolveWebhook ?? (async () => this.webhookUrl);
  }

  private async prepareDelivery(userId: string | null): Promise<string> {
    const webhookUrl = await this.resolveWebhook(userId);
    if (!webhookUrl) throw new AppError('WeCom webhook is not configured', 'WECOM_NOT_CONFIGURED', 409, false);
    return webhookUrl;
  }

  private async scheduleOrFail(recordId: string, userId: string | null): Promise<void> {
    try {
      await this.prepareDelivery(userId);
      this.schedule(recordId);
    } catch (error) {
      await this.notifications.markFailed(recordId, error instanceof AppError ? error.code : 'WECOM_DELIVERY_FAILED');
    }
  }

  private schedule(recordId: string): void {
    const task = this.deliver(recordId).catch(() => {}).finally(() => this.background.delete(task));
    this.background.add(task);
  }

  async waitForIdle(): Promise<void> { await Promise.all([...this.background]); }

  async enqueueAutomatic(caseId: string, screenshotId: string): Promise<{ created: boolean; notification: WecomNotificationRecord | null }> {
    const [caseValue, screenshot] = await Promise.all([this.cases.findById(caseId), this.screenshots.findById(screenshotId)]);
    if (!caseValue || !screenshot || screenshot.caseId !== caseId) return { created: false, notification: null };
    if (!TERMINAL_STATUSES.has(caseValue.status as WecomTerminalStatus) || screenshot.type !== screenshotType(caseValue)) return { created: false, notification: null };
    const result = await this.notifications.createPending({ caseId, platformAccountId: caseValue.platformAccountId, resultStatus: caseValue.status as WecomTerminalStatus, screenshotId, triggerId: screenshotId });
    if (result.created) {
      const account = await this.accounts.findById(caseValue.platformAccountId);
      if (!account?.salespersonName || !account.assistantName) await this.notifications.markFailed(result.record.id, 'CONTACTS_NOT_CONFIGURED');
      else await this.scheduleOrFail(result.record.id, caseValue.createdBy);
    }
    return { created: result.created, notification: result.record };
  }

  async enqueueRepeatForEvidence(triggerId: string, input: WecomRepeatEvidenceInput): Promise<{ created: number }> {
    if (!input.platformAccountId || input.evidenceEventIds.length === 0) return { created: 0 };
    const expected = new Set(input.evidenceEventIds);
    const accountCases = await this.cases.list({
      platformAccountId: input.platformAccountId,
      createdBy: input.requestedBy,
      limit: 101,
    });
    const account = await this.accounts.findById(input.platformAccountId);
    let created = 0;
    for (const caseValue of accountCases) {
      if (!expected.has(caseValue.sourceEventId) || !TERMINAL_STATUSES.has(caseValue.status as WecomTerminalStatus)) continue;
      const screenshot = await this.screenshots.findByCaseIdAndType(caseValue.id, screenshotType(caseValue));
      if (!screenshot) continue;
      const sourceSent = (await this.notifications.listByCaseId(caseValue.id)).some((record) => (
        record.platformAccountId === input.platformAccountId
        && record.resultStatus === caseValue.status
        && record.screenshotId === screenshot.id
        && record.status === 'sent'
        && record.createdAt.getTime() < input.startedAt.getTime()
      ));
      if (!sourceSent) continue;
      const result = await this.notifications.createPending({
        caseId: caseValue.id,
        platformAccountId: input.platformAccountId,
        resultStatus: caseValue.status as WecomTerminalStatus,
        screenshotId: screenshot.id,
        triggerId,
      });
      if (!result.created) continue;
      created += 1;
      if (!account?.salespersonName || !account.assistantName) await this.notifications.markFailed(result.record.id, 'CONTACTS_NOT_CONFIGURED');
      else await this.scheduleOrFail(result.record.id, caseValue.createdBy);
    }
    return { created };
  }

  private async source(record: WecomNotificationRecord): Promise<{ caseValue: CaseRecord; screenshot: ScreenshotRecord; contactNames: string[] }> {
    const [caseValue, screenshot, account] = await Promise.all([this.cases.findById(record.caseId), this.screenshots.findById(record.screenshotId), this.accounts.findById(record.platformAccountId)]);
    if (!caseValue || !screenshot || !account) throw new NotFoundError('WeCom notification source not found');
    if (caseValue.status !== record.resultStatus || screenshot.caseId !== record.caseId || screenshot.type !== screenshotType(caseValue)) {
      throw new ConflictError('WeCom notification source changed', 'WECOM_SOURCE_CHANGED');
    }
    if (!account.salespersonName || !account.assistantName) throw new ConflictError('WeCom contacts are not configured', 'CONTACTS_NOT_CONFIGURED');
    return { caseValue, screenshot, contactNames: [...new Set([account.salespersonName, account.assistantName])] };
  }

  private async deliver(recordId: string): Promise<void> {
    const claimed = await this.notifications.markSending(recordId);
    if (!claimed) return;
    try {
      const { caseValue, screenshot, contactNames } = await this.source(claimed);
      const webhookUrl = await this.prepareDelivery(caseValue.createdBy);
      const stream = await this.storage.get(screenshot.objectKey);
      if (!stream) throw new Error('Missing screenshot');
      const image = await streamBuffer(stream, screenshot.byteSize);
      const payloads: WecomPayload[] = [
        { msgtype: 'image', image: { base64: image.toString('base64'), md5: createHash('md5').update(image).digest('hex') } },
        { msgtype: 'text', text: { content: resultText(caseValue, contactNames) } },
      ];
      for (const payload of payloads) {
        const response = await this.transport(webhookUrl, payload);
        if (response.errcode !== 0) throw new Error('WeCom rejected delivery');
      }
      await this.notifications.markSent(recordId);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'WECOM_DELIVERY_FAILED';
      await this.notifications.markFailed(recordId, code);
    }
  }

  async retry(id: string, access: CaseAccess): Promise<void> {
    const record = await this.notifications.findById(id);
    if (!record) throw new NotFoundError('WeCom notification not found');
    const caseValue = await this.cases.findById(record.caseId, ownerIdFor(access));
    if (!caseValue) throw new ForbiddenError();
    if (record.status !== 'failed') throw new ConflictError('WeCom notification is not retryable', 'WECOM_NOT_RETRYABLE');
    const preconditionFailure = record.errorCode === 'CONTACTS_NOT_CONFIGURED'
      || record.errorCode === 'WECOM_NOT_CONFIGURED'
      || record.errorCode === 'WECOM_WEBHOOK_DECRYPT_FAILED';
    const maximumAttempts = preconditionFailure ? 1 : 2;
    if (record.attemptCount >= maximumAttempts) throw new ConflictError('WeCom notification retry limit reached', 'WECOM_RETRY_LIMIT');
    await this.deliver(id);
    let updated = await this.notifications.findById(id);
    if (preconditionFailure && updated?.status === 'failed' && updated.attemptCount < 2) {
      await this.notifications.markSending(id);
      updated = await this.notifications.markFailed(id, updated.errorCode ?? 'WECOM_DELIVERY_FAILED');
    }
    if (updated?.status !== 'sent') throw new AppError('WeCom delivery failed', updated?.errorCode ?? 'WECOM_DELIVERY_FAILED', 502, false);
  }

  async listForCase(caseId: string, access: CaseAccess) {
    const caseValue = await this.cases.findById(caseId, ownerIdFor(access));
    if (!caseValue) throw new NotFoundError('Case not found');
    return (await this.notifications.listByCaseId(caseId)).map((record) => ({
      id: record.id,
      resultStatus: record.resultStatus,
      status: record.status,
      errorCode: record.errorCode,
      attemptCount: record.attemptCount,
      updatedAt: record.updatedAt.toISOString(),
      sentAt: record.sentAt?.toISOString() ?? null,
    }));
  }

}
