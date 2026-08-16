import type { EncryptedUserWecomWebhook, UserWecomWebhookRepository } from './types.ts';

function copy(value: EncryptedUserWecomWebhook): EncryptedUserWecomWebhook {
  return { ciphertext: Buffer.from(value.ciphertext), iv: Buffer.from(value.iv), tag: Buffer.from(value.tag), version: value.version };
}

export class MemoryUserWecomWebhookRepository implements UserWecomWebhookRepository {
  private readonly records = new Map<string, EncryptedUserWecomWebhook>();

  async findByUserId(userId: string): Promise<EncryptedUserWecomWebhook | null> {
    const value = this.records.get(userId);
    return value ? copy(value) : null;
  }

  async save(userId: string, value: EncryptedUserWecomWebhook): Promise<boolean> {
    this.records.set(userId, copy(value));
    return true;
  }

  async clear(userId: string): Promise<boolean> {
    this.records.delete(userId);
    return true;
  }

  async configuredUserIds(userIds: string[]): Promise<Set<string>> {
    return new Set(userIds.filter((id) => this.records.has(id)));
  }
}
