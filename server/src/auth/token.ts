import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newSessionId(): string {
  return randomUUID();
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}
