import type { AuthRepository } from '../auth/types.ts';
import { AppError, NotFoundError, ValidationError } from '../errors.ts';
import { decryptUserWebhook, encryptUserWebhook } from './crypto.ts';
import type { UserWecomWebhookRepository, UserWecomWebhookStatus } from './types.ts';

export function validateWecomWebhookUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ValidationError([{ field: 'webhookUrl', code: 'required' }]);
  }
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError([{ field: 'webhookUrl', code: 'invalid' }]);
  }
  const queryEntries = [...parsed.searchParams.entries()];
  const explicitPort = /^https:\/\/[^/?#]*:\d+(?:[/?#]|$)/i.test(value);
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'qyapi.weixin.qq.com'
    || explicitPort
    || parsed.pathname !== '/cgi-bin/webhook/send'
    || queryEntries.length !== 1
    || queryEntries[0][0] !== 'key'
    || queryEntries[0][1].trim() === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
  ) {
    throw new ValidationError([{ field: 'webhookUrl', code: 'invalid' }]);
  }
  return parsed.toString();
}

export class UserWecomWebhookService {
  private readonly repository: UserWecomWebhookRepository;
  private readonly users: AuthRepository;
  private readonly masterKey: Buffer;
  private readonly fallbackUrl: string | undefined;

  constructor(
    repository: UserWecomWebhookRepository,
    users: AuthRepository,
    masterKey: Buffer,
    fallbackUrl?: string,
  ) {
    this.repository = repository;
    this.users = users;
    this.masterKey = masterKey;
    this.fallbackUrl = fallbackUrl;
  }

  private async requireUser(userId: string): Promise<void> {
    if (!await this.users.findUserById(userId)) throw new NotFoundError('User not found');
  }

  async status(userId: string): Promise<UserWecomWebhookStatus> {
    await this.requireUser(userId);
    return { userId, wecomWebhookConfigured: (await this.repository.findByUserId(userId)) !== null };
  }

  async statuses(userIds: string[]): Promise<Map<string, boolean>> {
    const configured = await this.repository.configuredUserIds(userIds);
    return new Map(userIds.map((id) => [id, configured.has(id)]));
  }

  async set(userId: string, webhookUrl: string): Promise<UserWecomWebhookStatus> {
    await this.requireUser(userId);
    const normalized = validateWecomWebhookUrl(webhookUrl);
    const saved = await this.repository.save(userId, encryptUserWebhook(this.masterKey, userId, normalized));
    if (!saved) throw new NotFoundError('User not found');
    return { userId, wecomWebhookConfigured: true };
  }

  async clear(userId: string): Promise<UserWecomWebhookStatus> {
    await this.requireUser(userId);
    if (!await this.repository.clear(userId)) throw new NotFoundError('User not found');
    return { userId, wecomWebhookConfigured: false };
  }

  async resolve(userId: string | null): Promise<string | undefined> {
    if (!userId) return this.fallbackUrl;
    const encrypted = await this.repository.findByUserId(userId);
    if (!encrypted) return this.fallbackUrl;
    try {
      return validateWecomWebhookUrl(decryptUserWebhook(this.masterKey, userId, encrypted));
    } catch {
      throw new AppError('User WeCom webhook cannot be decrypted', 'WECOM_WEBHOOK_DECRYPT_FAILED', 500, false);
    }
  }
}
