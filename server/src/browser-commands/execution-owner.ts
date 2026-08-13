import type { FastifyRequest } from 'fastify';

import type { AuthContext } from '../auth/service.ts';
import { ForbiddenError } from '../errors.ts';
import type { CaseAccess } from '../cases/types.ts';
import type { BrowserCommandService } from './service.ts';
import type { BrowserCommandType } from './types.ts';

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export async function executionOwnedAccess(
  request: FastifyRequest,
  service: BrowserCommandService | undefined,
  fallback: CaseAccess,
  allowedTypes: readonly BrowserCommandType[],
): Promise<CaseAccess> {
  const context = request.auth as AuthContext | null;
  if (context?.session.clientType !== 'extension') return fallback;
  const commandId = header(request, 'x-browser-command-id');
  const deviceId = header(request, 'x-browser-command-device');
  const claimToken = header(request, 'x-browser-command-claim');
  if (!commandId && !deviceId && !claimToken) return fallback;
  if (!service || !commandId || !deviceId || !claimToken || context.extensionDevice?.deviceId !== deviceId) {
    throw new ForbiddenError('Browser command lease is not valid');
  }
  const requestedBy = await service.authorizeExecutionOwner(commandId, deviceId, claimToken, allowedTypes);
  return { userId: requestedBy, role: 'user' };
}
