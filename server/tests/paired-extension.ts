import { randomUUID } from 'node:crypto';

import { hashToken } from '../src/auth/token.ts';
import type { AuthRepository } from '../src/auth/types.ts';

const repositories = new WeakMap<object, AuthRepository>();

export function bindPairedExtensionRepository(app: object, repository: AuthRepository): void {
  repositories.set(app, repository);
}

/** Creates a device-bound bearer only for route tests; production tokens use HTTP pairing. */
export async function createPairedExtensionToken(
  repository: AuthRepository,
  username = 'worker',
): Promise<{ token: string; deviceId: string }> {
  const user = await repository.findUserByUsername(username);
  if (!user) throw new Error(`Test user not found: ${username}`);
  const deviceId = randomUUID();
  const device = await repository.createExtensionDevice({
    id: randomUUID(),
    deviceId,
    label: 'test extension',
    pairedBy: user.id,
  });
  const token = `paired-extension-${randomUUID()}`;
  await repository.createSession({
    id: randomUUID(),
    userId: user.id,
    tokenHash: hashToken(token),
    clientType: 'extension',
    extensionDeviceId: device.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { token, deviceId };
}

export async function pairedExtensionTokenForApp(
  app: object,
  username = 'worker',
): Promise<{ token: string; deviceId: string }> {
  const repository = repositories.get(app);
  if (!repository) throw new Error('Test app has no paired-extension repository');
  return createPairedExtensionToken(repository, username);
}
