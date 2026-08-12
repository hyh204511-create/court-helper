import { createHash } from 'node:crypto';

import { AppError, ConflictError, DependencyUnavailableError } from '../errors.ts';
import { ownerIdFor, type CaseAccess, type CaseRecord, type CaseRepository } from '../cases/types.ts';
import type { ScreenshotRepository, ScreenshotType } from '../screenshots/types.ts';
import type { StorageBackend } from '../storage/types.ts';

export const MAX_WECOM_IMAGE_BYTES = 2 * 1024 * 1024;

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
  if (expectedBytes > MAX_WECOM_IMAGE_BYTES) {
    throw new AppError('WeCom image is too large', 'WECOM_IMAGE_TOO_LARGE', 413, false);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WECOM_IMAGE_BYTES) {
      throw new AppError('WeCom image is too large', 'WECOM_IMAGE_TOO_LARGE', 413, false);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function defaultWecomTransport(url: string, payload: WecomPayload): Promise<{ errcode?: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('WeCom request failed');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid WeCom response');
  return value as { errcode?: unknown };
}

export class WecomNotificationService {
  private readonly webhookUrl: string | undefined;
  private readonly cases: CaseRepository;
  private readonly screenshots: ScreenshotRepository;
  private readonly storage: StorageBackend;
  private readonly transport: WecomTransport;

  constructor(
    webhookUrl: string | undefined,
    cases: CaseRepository,
    screenshots: ScreenshotRepository,
    storage: StorageBackend,
    transport: WecomTransport = defaultWecomTransport,
  ) {
    this.webhookUrl = webhookUrl;
    this.cases = cases;
    this.screenshots = screenshots;
    this.storage = storage;
    this.transport = transport;
  }

  async send(caseId: string, mobiles: string[], access: CaseAccess): Promise<void> {
    if (!this.webhookUrl) {
      throw new DependencyUnavailableError('WeCom webhook is not configured', 'WECOM_NOT_CONFIGURED');
    }
    const caseValue = await this.cases.findById(caseId, ownerIdFor(access));
    if (!caseValue) throw new ConflictError('Case or evidence is unavailable', 'WECOM_SCREENSHOT_MISSING');
    const screenshot = await this.screenshots.findByCaseIdAndType(caseId, screenshotType(caseValue));
    if (!screenshot) throw new ConflictError('Matching screenshot is missing', 'WECOM_SCREENSHOT_MISSING');
    const stream = await this.storage.get(screenshot.objectKey);
    if (!stream) throw new ConflictError('Matching screenshot is missing', 'WECOM_SCREENSHOT_MISSING');
    const image = await streamBuffer(stream, screenshot.byteSize);
    const recipients = [...new Set(mobiles)];
    const payloads: WecomPayload[] = [
      {
        msgtype: 'image',
        image: {
          base64: image.toString('base64'),
          md5: createHash('md5').update(image).digest('hex'),
        },
      },
      {
        msgtype: 'text',
        text: { content: resultText(caseValue), mentioned_mobile_list: recipients },
      },
    ];
    try {
      for (const payload of payloads) {
        const response = await this.transport(this.webhookUrl, payload);
        if (response.errcode !== 0) throw new Error('WeCom rejected delivery');
      }
    } catch {
      throw new AppError('WeCom delivery failed', 'WECOM_DELIVERY_FAILED', 502, true);
    }
  }
}
