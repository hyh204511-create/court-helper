export interface EncryptedUserWecomWebhook {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  version: 1;
}

export interface UserWecomWebhookRepository {
  findByUserId(userId: string): Promise<EncryptedUserWecomWebhook | null>;
  save(userId: string, value: EncryptedUserWecomWebhook): Promise<boolean>;
  clear(userId: string): Promise<boolean>;
  configuredUserIds(userIds: string[]): Promise<Set<string>>;
}

export interface UserWecomWebhookStatus {
  userId: string;
  wecomWebhookConfigured: boolean;
}
