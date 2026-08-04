import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function resolveRequestId(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(header)) {
    return header;
  }
  return randomUUID();
}

export function attachRequestId(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  request.requestId = resolveRequestId(request);
  reply.header('x-request-id', request.requestId);
  done();
}
