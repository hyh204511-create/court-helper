import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { EncryptedCredential } from './types.ts';

export interface PlainCredential {
  account: string;
  password: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const SECRET_VERSION = 1;

function aadFor(id: string): Buffer {
  return Buffer.from(`platform_account:${id}:v${SECRET_VERSION}`, 'utf8');
}

export function encryptCredential(
  id: string,
  credential: PlainCredential,
  masterKey: Buffer,
): EncryptedCredential {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  cipher.setAAD(aadFor(id));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(credential), 'utf8')),
    cipher.final(),
  ]);
  return {
    secretCiphertext: ciphertext,
    secretIv: iv,
    secretTag: cipher.getAuthTag(),
    secretVersion: SECRET_VERSION,
  };
}

export function decryptCredential(
  id: string,
  encrypted: EncryptedCredential,
  masterKey: Buffer,
): PlainCredential {
  if (encrypted.secretVersion !== SECRET_VERSION) {
    throw new Error('Unsupported credential version');
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey, encrypted.secretIv);
  decipher.setAAD(aadFor(id));
  decipher.setAuthTag(encrypted.secretTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.secretCiphertext),
    decipher.final(),
  ]).toString('utf8');
  const parsed: unknown = JSON.parse(plaintext);
  if (
    !parsed || typeof parsed !== 'object'
    || typeof (parsed as { account?: unknown }).account !== 'string'
    || typeof (parsed as { password?: unknown }).password !== 'string'
  ) {
    throw new Error('Invalid credential payload');
  }
  return {
    account: (parsed as { account: string }).account,
    password: (parsed as { password: string }).password,
  };
}
