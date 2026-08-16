import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { EncryptedUserWecomWebhook } from './types.ts';

const INFO = Buffer.from('court-helper:user-wecom-webhook:v1', 'utf8');

function encryptionKey(masterKey: Buffer): Buffer {
  if (masterKey.length !== 32) throw new Error('Invalid webhook encryption key');
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), INFO, 32));
}

function aad(userId: string): Buffer {
  return Buffer.from(`user-wecom-webhook:${userId}:v1`, 'utf8');
}

export function encryptUserWebhook(masterKey: Buffer, userId: string, webhookUrl: string): EncryptedUserWecomWebhook {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(masterKey), iv);
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([cipher.update(webhookUrl, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), version: 1 };
}

export function decryptUserWebhook(masterKey: Buffer, userId: string, value: EncryptedUserWecomWebhook): string {
  if (value.version !== 1 || value.iv.length !== 12 || value.tag.length !== 16) {
    throw new Error('Unable to decrypt user webhook');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(masterKey), value.iv);
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(value.tag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Unable to decrypt user webhook');
  }
}
