import { createHash } from 'node:crypto';

import { AppError, ConflictError, DependencyUnavailableError, ForbiddenError, NotFoundError } from '../errors.ts';
import { ownerIdFor, type CaseAccess, type CaseRecord, type CaseRepository } from '../cases/types.ts';
import type { PlatformAccountRepository } from '../platform-accounts/types.ts';
import type { ScreenshotRecord, ScreenshotRepository, ScreenshotType } from '../screenshots/types.ts';
import type { StorageBackend } from '../storage/types.ts';
import type { WecomNotificationRecord, WecomNotificationRepository, WecomTerminalStatus } from './types.ts';

export const MAX_WECOM_IMAGE_BYTES = 2 * 1024 * 1024;
const TERMINAL_STATUSES = new Set<WecomTerminalStatus>(['立案成功', '强执成功', '已驳回']);

export type WecomPayload =
  | { msgtype: 'image'; image: { base64: string; md5: string } }
  | { msgtype: 'text'; text: { content: string; mentioned_mobile_list: string[] } };
export type WecomTransport = (url: string, payload: WecomPayload) => Promise<{ errcode?: unknown }>;

function screenshotType(value: CaseRecord): ScreenshotType {
  if (value.status === '已驳回') return 'reject';
  if (value.kind === 'qz') return 'enforcement_success';
  return 'success';
}

function resultText(value: CaseRecord): string {
  const lines = [
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
  constructor(
    webhookUrl: string | undefined,
    cases: CaseRepository,
    accounts: PlatformAccountRepository,
    screenshots: ScreenshotRepository,
    notifications: WecomNotificationRepository,
    storage: StorageBackend,
    transport: WecomTransport = defaultWecomTransport,
  ) {
    this.webhookUrl = webhookUrl;
    this.cases = cases;
    this.accounts = accounts;
    this.screenshots = screenshots;
    this.notifications = notifications;
    this.storage = storage;
    this.transport = transport;
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
    const result = await this.notifications.createPending({ caseId, platformAccountId: caseValue.platformAccountId, resultStatus: caseValue.status as WecomTerminalStatus, screenshotId });
    if (result.created) {
      const account = await this.accounts.findById(caseValue.platformAccountId);
      if (!account?.salespersonMobile || !account.assistantMobile) await this.notifications.markFailed(result.record.id, 'CONTACTS_NOT_CONFIGURED');
      else if (!this.webhookUrl) await this.notifications.markFailed(result.record.id, 'WECOM_NOT_CONFIGURED');
      else this.schedule(result.record.id);
    }
    return { created: result.created, notification: result.record };
  }

  private async source(record: WecomNotificationRecord): Promise<{ caseValue: CaseRecord; screenshot: ScreenshotRecord; mobiles: string[] }> {
    const [caseValue, screenshot, account] = await Promise.all([this.cases.findById(record.caseId), this.screenshots.findById(record.screenshotId), this.accounts.findById(record.platformAccountId)]);
    if (!caseValue || !screenshot || !account) throw new NotFoundError('WeCom notification source not found');
    if (!account.salespersonMobile || !account.assistantMobile) throw new ConflictError('WeCom contacts are not configured', 'CONTACTS_NOT_CONFIGURED');
    return { caseValue, screenshot, mobiles: [...new Set([account.salespersonMobile, account.assistantMobile])] };
  }

  private async deliver(recordId: string): Promise<void> {
    if (!this.webhookUrl) { await this.notifications.markFailed(recordId, 'WECOM_NOT_CONFIGURED'); return; }
    const claimed = await this.notifications.markSending(recordId);
    if (!claimed) return;
    try {
      const { caseValue, screenshot, mobiles } = await this.source(claimed);
      const stream = await this.storage.get(screenshot.objectKey);
      if (!stream) throw new Error('Missing screenshot');
      const image = await streamBuffer(stream, screenshot.byteSize);
      const payloads: WecomPayload[] = [
        { msgtype: 'image', image: { base64: image.toString('base64'), md5: createHash('md5').update(image).digest('hex') } },
        { msgtype: 'text', text: { content: resultText(caseValue), mentioned_mobile_list: mobiles } },
      ];
      for (const payload of payloads) {
        const response = await this.transport(this.webhookUrl, payload);
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
    await this.deliver(id);
    const updated = await this.notifications.findById(id);
    if (updated?.status !== 'sent') throw new AppError('WeCom delivery failed', updated?.errorCode ?? 'WECOM_DELIVERY_FAILED', 502, false);
  }

  async send(caseId: string, mobiles: string[], access: CaseAccess): Promise<void> {
    if (!this.webhookUrl) throw new DependencyUnavailableError('WeCom webhook is not configured', 'WECOM_NOT_CONFIGURED');
    const caseValue = await this.cases.findById(caseId, ownerIdFor(access));
    if (!caseValue) throw new ConflictError('Case or evidence is unavailable', 'WECOM_SCREENSHOT_MISSING');
    const screenshot = await this.screenshots.findByCaseIdAndType(caseId, screenshotType(caseValue));
    if (!screenshot) throw new ConflictError('Matching screenshot is missing', 'WECOM_SCREENSHOT_MISSING');
    const stream = await this.storage.get(screenshot.objectKey);
    if (!stream) throw new ConflictError('Matching screenshot is missing', 'WECOM_SCREENSHOT_MISSING');
    const image = await streamBuffer(stream, screenshot.byteSize);
    try {
      for (const payload of [{ msgtype: 'image', image: { base64: image.toString('base64'), md5: createHash('md5').update(image).digest('hex') } }, { msgtype: 'text', text: { content: resultText(caseValue), mentioned_mobile_list: [...new Set(mobiles)] } }] as WecomPayload[]) {
        const response = await this.transport(this.webhookUrl, payload); if (response.errcode !== 0) throw new Error();
      }
    } catch { throw new AppError('WeCom delivery failed', 'WECOM_DELIVERY_FAILED', 502, true); }
  }
}
