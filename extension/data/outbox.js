// outbox.js — 远端同步持久化队列
// 队列只保存 JSON 载荷和本地 blobRef，不把截图 Blob、凭据或 password 广播/写入事件载荷。
import {
  STORE_OUTBOX,
  clearStore,
  getAll,
  getByKey,
  put,
} from "./db.js";

export { STORE_OUTBOX };

export const OUTBOX_STATUSES = Object.freeze([
  "pending",
  "uploading",
  "sent",
  "conflict",
  "needs_human",
]);
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 60_000;

const FORBIDDEN_KEYS = new Set([
  "password",
  "captcha",
  "token",
  "authorization",
  "credential",
  "credentials",
  "secret",
  "image",
  "successImage",
  "rejectImage",
  "blob",
  "file",
  "screenshot",
]);

function newId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `outbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeValue(value, key = "") {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof Blob !== "undefined" && value instanceof Blob) return undefined;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item)).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeValue(childValue, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return undefined;
}

function sanitizeBlobRef(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const ref = {};
  for (const key of ["storeName", "uid", "field", "caseId", "screenshotType"]) {
    if (typeof value[key] === "string" && value[key] !== "") ref[key] = value[key];
  }
  return Object.keys(ref).length ? ref : null;
}

function normalizeNow(now) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(value) ? value : Date.now();
}

async function findByMutationId(clientMutationId) {
  const events = await getAll(STORE_OUTBOX);
  return events.find((event) => event.clientMutationId === clientMutationId);
}

function assertStatus(status) {
  if (!OUTBOX_STATUSES.includes(status)) throw new TypeError(`invalid outbox status: ${status}`);
}

export async function enqueue({
  id,
  type,
  payload = {},
  blobRef = null,
  clientMutationId,
} = {}) {
  if (typeof type !== "string" || type.trim() === "") throw new TypeError("outbox type required");
  const eventId = typeof id === "string" && id.trim() ? id : newId();
  const mutationId = typeof clientMutationId === "string" && clientMutationId.trim()
    ? clientMutationId
    : eventId;
  const existing = await findByMutationId(mutationId);
  if (existing) return existing;

  const event = {
    id: eventId,
    clientMutationId: mutationId,
    type,
    payload: sanitizeValue(payload) ?? {},
    blobRef: sanitizeBlobRef(blobRef),
    status: "pending",
    attempts: 0,
    nextRetryAt: 0,
  };
  await put(STORE_OUTBOX, event);
  return event;
}

export async function getOutbox(id) {
  return getByKey(STORE_OUTBOX, id);
}

export async function listOutbox({ status, readyAt, limit } = {}) {
  if (status !== undefined) assertStatus(status);
  const threshold = readyAt === undefined ? undefined : normalizeNow(readyAt);
  const events = (await getAll(STORE_OUTBOX))
    .filter((event) => status === undefined || event.status === status)
    .filter((event) => threshold === undefined || Number(event.nextRetryAt ?? 0) <= threshold)
    .sort((a, b) => (a.nextRetryAt - b.nextRetryAt) || a.id.localeCompare(b.id));
  return Number.isSafeInteger(limit) && limit >= 0 ? events.slice(0, limit) : events;
}

async function update(id, changes) {
  const current = await getOutbox(id);
  if (!current) return undefined;
  const next = { ...current, ...changes };
  assertStatus(next.status);
  await put(STORE_OUTBOX, next);
  return next;
}

export async function markNeedsHuman(id, { reason = "NEEDS_HUMAN", conflicts = [] } = {}) {
  return update(id, {
    status: "needs_human",
    nextRetryAt: 0,
    lastErrorCode: String(reason),
    conflicts: Array.isArray(conflicts) ? sanitizeValue(conflicts) : [],
  });
}

export async function markConflict(id, conflicts = []) {
  return update(id, {
    status: "conflict",
    nextRetryAt: 0,
    lastErrorCode: "CONFLICT",
    conflicts: Array.isArray(conflicts) ? sanitizeValue(conflicts) : [],
  });
}

export async function retry(id) {
  const current = await getOutbox(id);
  if (!current) return undefined;
  return update(id, {
    status: "pending",
    nextRetryAt: 0,
    lastErrorCode: null,
    conflicts: [],
  });
}

export async function clearOutbox() {
  return clearStore(STORE_OUTBOX);
}

function conflictOf(value) {
  return Boolean(
    value?.status === 409
      || value?.code === "CONFLICT"
      || value?.code === "ACCOUNT_DISABLED"
      || (Array.isArray(value?.conflicts) && value.conflicts.length > 0),
  );
}

/**
 * 依次发送到期事件。上传前先持久化 uploading，浏览器崩溃后下一次 drain 会安全重放，
 * 依赖 clientMutationId 保护服务端幂等。失败不会静默丢弃。
 */
export async function drain({
  send,
  now = Date.now,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  limit,
} = {}) {
  if (typeof send !== "function") throw new TypeError("outbox send function required");
  const currentTime = normalizeNow(now);
  const all = await listOutbox({ limit });
  const due = all.filter((event) => ["pending", "uploading"].includes(event.status))
    .filter((event) => Number(event.nextRetryAt ?? 0) <= currentTime);
  const summary = { sent: 0, conflict: 0, retried: 0, needsHuman: 0, skipped: all.length - due.length };

  for (const event of due) {
    const uploading = await update(event.id, { status: "uploading" });
    if (!uploading) continue;
    try {
      const result = await send(uploading, { idempotencyKey: uploading.clientMutationId });
      if (conflictOf(result)) {
        await markConflict(event.id, result.conflicts ?? []);
        summary.conflict += 1;
      } else {
        await update(event.id, { status: "sent", nextRetryAt: 0, sentAt: currentTime });
        summary.sent += 1;
      }
    } catch (error) {
      if (conflictOf(error)) {
        await markConflict(event.id, error.conflicts ?? []);
        summary.conflict += 1;
        continue;
      }
      const attempts = Number(uploading.attempts ?? 0) + 1;
      if (attempts >= maxAttempts) {
        await update(event.id, {
          status: "needs_human",
          attempts,
          nextRetryAt: 0,
          lastErrorCode: typeof error?.code === "string" ? error.code : "REMOTE_ERROR",
        });
        summary.needsHuman += 1;
        continue;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempts - 1)));
      await update(event.id, {
        status: "pending",
        attempts,
        nextRetryAt: currentTime + delay,
        lastErrorCode: typeof error?.code === "string" ? error.code : "REMOTE_ERROR",
      });
      summary.retried += 1;
    }
  }
  return summary;
}

export async function pendingCount() {
  const events = await getAll(STORE_OUTBOX);
  return events.filter((event) => ["pending", "uploading"].includes(event.status)).length;
}
