import type { FastifyInstance, FastifyRequest } from 'fastify';

import { CASE_KINDS, CASE_STATUSES, type CaseAccess, type CaseSyncItem } from './types.ts';
import { publicCase, CaseService } from './service.ts';
import { AuthService } from '../auth/service.ts';
import { authenticateRequest } from '../auth/routes.ts';
import { ValidationError } from '../errors.ts';
import type { BrowserCommandService } from '../browser-commands/service.ts';
import { executionOwnedAccess } from '../browser-commands/execution-owner.ts';

interface RequestBody {
  [key: string]: unknown;
}

interface QueryParams {
  cursor?: unknown;
  after?: unknown;
  limit?: unknown;
  kind?: unknown;
  status?: unknown;
  platformAccountId?: unknown;
  keyword?: unknown;
  needsHuman?: unknown;
  from?: unknown;
  to?: unknown;
}

interface RegisterCaseOptions {
  service: CaseService;
  authService: AuthService;
  prefix: string;
  browserCommandService?: BrowserCommandService;
}

const SYNC_ITEM_FIELDS = new Set([
  'eventId',
  'clientUid',
  'platformAccountId',
  'kind',
  'plaintiff',
  'defendant',
  'status',
  'filedTime',
  'caseNumber',
  'rejectTime',
  'rejectReason',
  'queryTime',
  'needsHuman',
  'errorCode',
  'sourceUpdatedAt',
]);

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function accessOf(request: FastifyRequest): CaseAccess {
  const auth = request.auth as NonNullable<typeof request.auth>;
  return { userId: auth.user.id, role: auth.user.role };
}

function bodyOf(request: FastifyRequest): RequestBody {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ValidationError([{ field: 'body', code: 'object_required' }]);
  }
  return request.body as RequestBody;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field, code: 'required' }]);
  }
  return value;
}

function databaseIdentifier(value: unknown, field: string): string {
  return requiredString(value, field).replaceAll('\u0000', '%00');
}

function requiredField(body: RequestBody, field: string): string {
  return requiredString(body[field], field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError([{ field, code: 'string_required' }]);
  }
  return value.replaceAll('\u0000', '');
}

function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError([{ field, code: 'invalid_enum' }]);
  }
  return value as T;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError([{ field, code: 'boolean_required' }]);
  }
  return value;
}

function dateOnlyValue(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError([{ field, code: 'required' }]);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError([{ field, code: 'date_required' }]);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new ValidationError([{ field, code: 'date_required' }]);
  }
  return value;
}

function dateTimeValue(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError([{ field, code: 'required' }]);
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError([{ field, code: 'datetime_required' }]);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ValidationError([{ field, code: 'datetime_required' }]);
  }
  return parsed.toISOString();
}

function parseSyncItem(value: unknown, index: number): CaseSyncItem {
  const field = (name: string) => `items[${index}].${name}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError([{ field: `items[${index}]`, code: 'object_required' }]);
  }
  const body = value as RequestBody;
  const unknownField = Object.keys(body).find((name) => !SYNC_ITEM_FIELDS.has(name));
  if (unknownField !== undefined) {
    throw new ValidationError([{ field: field(unknownField), code: 'unknown_field' }]);
  }

  const kind = enumValue(body.kind, field('kind'), CASE_KINDS);
  const status = enumValue(body.status, field('status'), CASE_STATUSES);
  if ((kind === 'li' && status === '强执成功') || (kind === 'qz' && status === '立案成功')) {
    throw new ValidationError([{ field: field('status'), code: 'kind_status_mismatch' }]);
  }

  const needsHuman = booleanValue(body.needsHuman, field('needsHuman'));
  if (status === 'UNKNOWN' && !needsHuman) {
    throw new ValidationError([{ field: field('needsHuman'), code: 'required_for_unknown' }]);
  }

  return {
    eventId: requiredString(body.eventId, field('eventId')),
    clientUid: databaseIdentifier(body.clientUid, field('clientUid')),
    platformAccountId: requiredString(body.platformAccountId, field('platformAccountId')),
    kind,
    plaintiff: nullableString(body.plaintiff, field('plaintiff')),
    defendant: nullableString(body.defendant, field('defendant')),
    status,
    filedTime: dateOnlyValue(body.filedTime, field('filedTime')),
    caseNumber: nullableString(body.caseNumber, field('caseNumber')),
    rejectTime: dateOnlyValue(body.rejectTime, field('rejectTime')),
    rejectReason: nullableString(body.rejectReason, field('rejectReason')),
    queryTime: dateTimeValue(body.queryTime, field('queryTime')),
    needsHuman,
    errorCode: nullableString(body.errorCode, field('errorCode')),
    sourceUpdatedAt: dateTimeValue(body.sourceUpdatedAt, field('sourceUpdatedAt'), true) as string,
  };
}

function queryOf(request: FastifyRequest): QueryParams {
  if (!request.query || typeof request.query !== 'object' || Array.isArray(request.query)) return {};
  return request.query as QueryParams;
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field, code: 'string_required' }]);
  }
  return value;
}

function queryKeyword(value: unknown): string | undefined {
  const keyword = queryString(value, 'keyword');
  if (keyword === undefined) return undefined;
  const normalized = keyword.trim();
  if (normalized.length > 200) {
    throw new ValidationError([{ field: 'keyword', code: 'maximum_exceeded' }]);
  }
  return normalized;
}

function queryInteger(value: unknown, field: string, fallback: number, maximum?: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError([{ field, code: 'integer_required' }]);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || (maximum !== undefined && parsed > maximum)) {
    throw new ValidationError([{ field, code: maximum === undefined ? 'integer_required' : 'maximum_exceeded' }]);
  }
  return parsed;
}

function queryLimit(value: unknown): number {
  const limit = queryInteger(value, 'limit', 50, 200);
  if (limit === 0) throw new ValidationError([{ field: 'limit', code: 'positive_required' }]);
  return limit;
}

function queryBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError([{ field, code: 'boolean_required' }]);
}

function listOptions(query: QueryParams, limit: number) {
  const from = dateOnlyValue(query.from, 'from');
  const to = dateOnlyValue(query.to, 'to');
  if (from !== null && to !== null && from > to) {
    throw new ValidationError([{ field: 'from', code: 'range_invalid' }]);
  }
  return {
    kind: query.kind === undefined ? undefined : enumValue(query.kind, 'kind', CASE_KINDS),
    status: query.status === undefined ? undefined : enumValue(query.status, 'status', CASE_STATUSES),
    platformAccountId: queryString(query.platformAccountId, 'platformAccountId'),
    keyword: queryKeyword(query.keyword),
    needsHuman: queryBoolean(query.needsHuman, 'needsHuman'),
    from: from ?? undefined,
    to: to ?? undefined,
    afterRevision: queryInteger(query.cursor, 'cursor', 0),
    limit,
  };
}

export function registerCaseRoutes(app: FastifyInstance, options: RegisterCaseOptions): void {
  const { authService, prefix, service } = options;
  const protectedPreHandler = async (request: FastifyRequest) => authenticateRequest(request, authService);

  app.post(route(prefix, '/sync/cases'), { preHandler: protectedPreHandler }, async (request) => {
    const body = bodyOf(request);
    requiredField(body, 'batchId');
    if (!Array.isArray(body.items)) {
      throw new ValidationError([{ field: 'items', code: 'array_required' }]);
    }
    if (body.items.length > 50) {
      throw new ValidationError([{ field: 'items', code: 'maximum_exceeded' }]);
    }
    const items = body.items.map((item, index) => parseSyncItem(item, index));
    return service.sync(items, await executionOwnedAccess(
      request,
      options.browserCommandService,
      accessOf(request),
      ['QUERY_LI', 'QUERY_QZ', 'QUERY_ALL_EXPORT'],
    ));
  });

  app.get(route(prefix, '/cases'), { preHandler: protectedPreHandler }, async (request) => {
    const query = queryOf(request);
    const limit = queryLimit(query.limit);
    const optionsForPage = listOptions(query, limit + 1);
    const values = await service.list(optionsForPage, accessOf(request));
    const hasMore = values.length > limit;
    const cases = (hasMore ? values.slice(0, limit) : values).map(publicCase);
    return {
      cases,
      nextCursor: hasMore ? values[limit - 1].revision : null,
    };
  });

  app.get(route(prefix, '/cases/:id'), { preHandler: protectedPreHandler }, async (request) => {
    const id = (request.params as { id: string }).id;
    return publicCase(await service.get(id, accessOf(request)));
  });

  app.get(route(prefix, '/sync/changes'), { preHandler: protectedPreHandler }, async (request) => {
    const query = queryOf(request);
    const after = queryInteger(query.after, 'after', 0);
    const limit = queryLimit(query.limit);
    const values = await service.changes(after, limit + 1, accessOf(request));
    const hasMore = values.length > limit;
    const cases = (hasMore ? values.slice(0, limit) : values).map(publicCase);
    return {
      cases,
      nextCursor: hasMore
        ? values[limit - 1].revision
        : await service.currentRevision(),
    };
  });
}
