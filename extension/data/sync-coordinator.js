// sync-coordinator.js — 插件端远端同步协调器
// 远端同步与采集/识别/Excel 隔离：本模块只负责游标、outbox、轮询和可展示状态。
import * as defaultDb from "./db.js";
import * as defaultOutbox from "./outbox.js";

export const SYNC_META_CURSOR = "sync.cursor";
export const SYNC_META_ACCOUNTS = "sync.accounts";
export const SYNC_META_ACCOUNTS_AT = "sync.accountsAt";
export const SYNC_META_LAST_SYNC = "sync.lastSyncAt";

// 兼容调用方使用更语义化的别名；值必须保持稳定，避免升级后重拉历史数据。
export const PULL_CURSOR_KEY = SYNC_META_CURSOR;
export const ACCOUNTS_CACHE_KEY = SYNC_META_ACCOUNTS;

export const FOREGROUND_POLL_MS = 4_000;
export const HIDDEN_POLL_MS = 15_000;
export const PULL_LIMIT = 200;
export const ACCOUNT_CACHE_TTL_MS = 5 * 60_000;

const RETRYABLE_CODES = new Set([
  "DEPENDENCY_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "RATE_LIMITED",
]);
const CASE_STATUSES = new Set(["立案成功", "强执成功", "已驳回", "审核中", "UNKNOWN"]);
const CONFLICT_CODES = new Set(["CONFLICT", "ACCOUNT_DISABLED", "NOT_FOUND"]);

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function cursorOf(value) {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function asIso(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return null;
}

async function sha256Hex(blob) {
  if (typeof blob?.arrayBuffer !== "function" || !globalThis.crypto?.subtle) {
    const error = new Error("SCREENSHOT_BLOB_UNAVAILABLE");
    error.code = "SCREENSHOT_BLOB_UNAVAILABLE";
    error.retryable = false;
    throw error;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function screenshotType(event) {
  if (event?.blobRef?.field === "rejectImage" || event?.payload?.status === "已驳回") return "reject";
  return event?.payload?.kind === "qz" ? "enforcement_success" : "success";
}

function makeNow(now) {
  return () => {
    const value = typeof now === "function" ? now() : now;
    return asIso(value) ?? new Date().toISOString();
  };
}

function dateOnly(value) {
  const iso = asIso(value);
  return iso ? iso.slice(0, 10) : (typeof value === "string" ? value.slice(0, 10) : null);
}

function safeAccountMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" ? value.id : "";
  const label = typeof value.label === "string" ? value.label : "";
  if (!id || !label) return null;
  return {
    id,
    label,
    enabled: value.enabled === true,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function safeAccounts(response) {
  const values = Array.isArray(response)
    ? response
    : Array.isArray(response?.platformAccounts)
      ? response.platformAccounts
      : [];
  return values.map(safeAccountMetadata).filter(Boolean);
}

function conflictCode(value) {
  return CONFLICT_CODES.has(value) ? value : "CONFLICT";
}

function safeConflict(value = {}) {
  if (!value || typeof value !== "object") return { code: "CONFLICT" };
  const conflict = { code: conflictCode(value.code) };
  for (const key of ["clientUid", "eventId"]) {
    if (typeof value[key] === "string" && value[key].length <= 256) conflict[key] = value[key];
  }
  return conflict;
}

function conflictsOf(value) {
  const values = Array.isArray(value) ? value : [];
  return values.map(safeConflict);
}

function isConflict(error) {
  return Boolean(
    error?.status === 409
      || error?.code === "CONFLICT"
      || error?.code === "ACCOUNT_DISABLED"
      || (Array.isArray(error?.conflicts) && error.conflicts.length > 0),
  );
}

function isUnavailable(error) {
  return Boolean(
    error?.status === 0
      || error?.status >= 500
      || RETRYABLE_CODES.has(error?.code),
  );
}

function errorCode(error) {
  if (typeof error?.code === "string" && error.code.length <= 64) return error.code;
  return isUnavailable(error) ? "NETWORK_UNAVAILABLE" : "SYNC_FAILED";
}

function maskAccount(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  const account = value.trim();
  if (account.length <= 1) return "*";
  if (account.length === 2) return `${account[0]}*`;
  return `${account[0]}***${account[account.length - 1]}`;
}

function conflictView(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return {
    id: typeof event?.id === "string" ? event.id : "",
    code: typeof event?.lastErrorCode === "string" ? event.lastErrorCode : "CONFLICT",
    maskedAccount: maskAccount(payload.account),
  };
}

function toLocalCase(value) {
  const status = CASE_STATUSES.has(value?.status) ? value.status : "UNKNOWN";
  return {
    platformAccountId: typeof value?.platformAccountId === "string" ? value.platformAccountId : "",
    account: typeof value?.account === "string" ? value.account : (value?.platformAccountId ?? ""),
    plaintiff: typeof value?.plaintiff === "string" ? value.plaintiff : "",
    defendant: typeof value?.defendant === "string" ? value.defendant : "",
    kind: value?.kind === "qz" ? "qz" : "li",
    status,
    filedTime: dateOnly(value?.filedTime),
    caseNumber: typeof value?.caseNumber === "string" ? value.caseNumber : null,
    rejectTime: dateOnly(value?.rejectTime),
    rejectReason: typeof value?.rejectReason === "string" ? value.rejectReason : null,
    queryTime: dateOnly(value?.queryTime),
    needsHuman: value?.needsHuman === true || status === "UNKNOWN",
    error: typeof value?.errorCode === "string" ? value.errorCode : null,
    sourceUpdatedAt: asIso(value?.sourceUpdatedAt),
    remoteRevision: cursorOf(value?.revision),
  };
}

function syncItem(event, accounts = []) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const accountId = typeof payload.platformAccountId === "string" && payload.platformAccountId
    ? payload.platformAccountId
    : accounts.find((account) => account.label === payload.account)?.id ?? "";
  const stableErrorCode = typeof payload.errorCode === "string"
    ? payload.errorCode.slice(0, 64)
    : payload.error
      ? "QUERY_FAILED"
      : null;
  return {
    eventId: event.clientMutationId,
    clientUid: String(payload.clientUid ?? payload.uid ?? event.id),
    platformAccountId: String(accountId),
    kind: payload.kind === "qz" ? "qz" : "li",
    plaintiff: typeof payload.plaintiff === "string" ? payload.plaintiff : "",
    defendant: typeof payload.defendant === "string" ? payload.defendant : "",
    status: CASE_STATUSES.has(payload.status) ? payload.status : "UNKNOWN",
    filedTime: payload.filedTime ?? (payload.filedDate ? `${payload.filedDate}T00:00:00.000Z` : null),
    caseNumber: typeof payload.caseNumber === "string" ? payload.caseNumber : null,
    rejectTime: payload.rejectTime ?? null,
    rejectReason: typeof payload.rejectReason === "string" ? payload.rejectReason : null,
    queryTime: payload.queryTime ?? null,
    needsHuman: payload.needsHuman === true || payload.status === "UNKNOWN",
    errorCode: stableErrorCode,
    sourceUpdatedAt: asIso(payload.sourceUpdatedAt) ?? new Date().toISOString(),
  };
}

function eventClientUid(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const value = payload.clientUid ?? payload.uid;
  return typeof value === "string" ? value : "";
}

function acceptedCaseFor(event, response) {
  const uid = eventClientUid(event);
  const eventIds = [event?.clientMutationId, event?.payload?.eventId]
    .filter((value) => typeof value === "string" && value !== "");
  if (!uid || eventIds.length === 0) return null;
  return (Array.isArray(response?.accepted) ? response.accepted : []).find((item) => (
    typeof item?.id === "string"
    && item.id !== ""
    && item.clientUid === uid
    && eventIds.includes(item.eventId)
  )) ?? null;
}

function eventSourceUpdatedAt(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return asIso(payload.sourceUpdatedAt ?? payload.updatedAt);
}

function conflictDetailsFor(uid, event) {
  if (Array.isArray(event?.conflicts) && event.conflicts.length) return event.conflicts;
  return [{
    clientUid: uid,
    eventId: typeof event?.clientMutationId === "string" ? event.clientMutationId : "",
    code: "CONFLICT",
  }];
}

function snapshot(state) {
  return {
    ...state,
    accounts: state.accounts.map((account) => ({ ...account })),
    conflicts: state.conflicts.map((conflict) => ({ ...conflict })),
  };
}

function singleFlight(task) {
  let inFlight = null;
  return (...args) => {
    if (inFlight) return inFlight;
    const current = Promise.resolve().then(() => task(...args));
    const wrapped = current.finally(() => {
      if (inFlight === wrapped) inFlight = null;
    });
    inFlight = wrapped;
    return wrapped;
  };
}

/**
 * 创建插件端同步协调器。
 *
 * `onPauseBatch` / `onResumeBatch` 由页面宿主接入已有批量状态机；协调器本身
 * 不直接操作采集器，避免远端逻辑改变采集、识别和 Excel 的核心流程。
 */
export function createSyncCoordinator({
  client = null,
  remoteClient = null,
  db = defaultDb,
  outbox = defaultOutbox,
  document = globalThis.document,
  scheduler = globalThis,
  pollIntervalMs = FOREGROUND_POLL_MS,
  hiddenPollIntervalMs = HIDDEN_POLL_MS,
  pullLimit = PULL_LIMIT,
  now = Date.now,
  onState,
  onStatus,
  onPauseBatch,
  onResumeBatch,
} = {}) {
  const remote = client ?? remoteClient;
  const timerApi = scheduler && typeof scheduler.setTimeout === "function" ? scheduler : globalThis;
  const foregroundDelay = Math.max(3000, Math.min(5000, numberOr(pollIntervalMs, FOREGROUND_POLL_MS)));
  const hiddenDelay = Math.max(foregroundDelay, numberOr(hiddenPollIntervalMs, HIDDEN_POLL_MS));
  const state = {
    status: remote ? "idle" : "disabled",
    cursor: 0,
    pendingCount: 0,
    lastSyncAt: null,
    maskedAccount: "",
    accounts: [],
    conflicts: [],
    message: remote ? "" : "未配置服务器",
    errorCode: null,
  };
  const getNow = makeNow(now);
  let started = false;
  let timer = null;
  let runPromise = null;
  let visibilityHandler = null;
  let batchPaused = false;
  let recoveryProbeUsed = false;

  function emit(patch = {}) {
    Object.assign(state, patch);
    const value = snapshot(state);
    try { onState?.(value); } catch { /* UI 回调故障不能破坏同步状态机。 */ }
    try { onStatus?.(value); } catch { /* 兼容旧调用方的别名回调。 */ }
    return value;
  }

  function hidden() {
    return Boolean(document?.hidden || document?.visibilityState === "hidden");
  }

  function clearTimer() {
    if (timer !== null) {
      timerApi.clearTimeout?.(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();
    if (!started) return;
    // 不自动无限重试：不可达后只允许一个轮询恢复探测，失败后等待用户重试。
    if (state.status === "offline" && recoveryProbeUsed) return;
    const delay = hidden() ? hiddenDelay : foregroundDelay;
    timer = timerApi.setTimeout(async () => {
      timer = null;
      if (!started) return;
      if (hidden()) {
        scheduleNext();
        return;
      }
      try {
        await syncNow();
      } catch {
        // syncNow 将可预期错误转换为状态；定时器不能产生未处理拒绝。
      }
    }, delay);
  }

  async function refreshOutboxState() {
    const events = await outbox.listOutbox();
    const pending = events.filter((event) => ["pending", "uploading"].includes(event.status)).length;
    const conflicts = events
      .filter((event) => ["conflict", "needs_human"].includes(event.status))
      .filter((event) => event.status === "conflict" || event.lastErrorCode === "CONFLICT" || event.conflicts?.length)
      .map(conflictView);
    emit({ pendingCount: pending, conflicts });
    return { pendingCount: pending, conflicts };
  }

  async function loadCursor() {
    const cursor = cursorOf(await db.getSyncMeta(SYNC_META_CURSOR));
    emit({ cursor });
    return cursor;
  }

  async function refreshAccountsImpl({ force = false } = {}) {
    const cached = await db.getSyncMeta(SYNC_META_ACCOUNTS);
    const cachedAt = asIso(await db.getSyncMeta(SYNC_META_ACCOUNTS_AT));
    const age = cachedAt ? Date.parse(getNow()) - Date.parse(cachedAt) : 0;
    if (!force && Array.isArray(cached) && (!cachedAt || age < ACCOUNT_CACHE_TTL_MS)) {
      const accounts = cached.map(safeAccountMetadata).filter(Boolean);
      emit({ accounts });
      return accounts;
    }
    if (!remote) return [];
    const response = await remote.listPlatformAccounts();
    const accounts = safeAccounts(response);
    await db.setSyncMeta(SYNC_META_ACCOUNTS, accounts);
    await db.setSyncMeta(SYNC_META_ACCOUNTS_AT, getNow());
    emit({ accounts });
    return accounts;
  }

  async function pullChangesImpl() {
    const currentCursor = await loadCursor();
    const response = await remote.pullChanges(currentCursor, Math.min(200, Math.max(1, cursorOf(pullLimit) || PULL_LIMIT)));
    const changes = Array.isArray(response?.cases)
      ? response.cases
      : Array.isArray(response?.changes) ? response.changes : [];
    const outboxEvents = typeof outbox.listOutbox === "function" ? await outbox.listOutbox() : [];
    for (const change of changes) {
      const uid = typeof change?.clientUid === "string" ? change.clientUid : "";
      if (!uid) continue;
      const local = toLocalCase(change);
      const store = local.kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
      const matchingEvents = outboxEvents.filter((event) => eventClientUid(event) === uid);
      if (matchingEvents.length) {
        const localRecord = typeof db.getByUid === "function" ? await db.getByUid(store, uid) : null;
        const unresolved = matchingEvents.find((event) => ["pending", "uploading", "conflict", "needs_human"].includes(event.status));
        if (unresolved) {
          if (unresolved.status !== "needs_human" && typeof outbox.markNeedsHuman === "function") {
            await outbox.markNeedsHuman(unresolved.id, {
              reason: "CONFLICT",
              conflicts: conflictDetailsFor(uid, unresolved),
            });
          }
          if (localRecord && !localRecord.needsHuman && typeof db.upsertByUid === "function") {
            await db.upsertByUid(store, uid, { ...localRecord, needsHuman: true }, { keepImages: true });
          }
          continue;
        }

        const remoteUpdatedAt = asIso(change.sourceUpdatedAt);
        const localUpdatedAt = [localRecord?.sourceUpdatedAt, localRecord?.updatedAt, ...matchingEvents.map(eventSourceUpdatedAt)]
          .map(asIso)
          .filter(Boolean)
          .map(Date.parse)
          .filter(Number.isFinite);
        if (remoteUpdatedAt && localUpdatedAt.some((value) => value >= Date.parse(remoteUpdatedAt))) continue;
      }
      await db.upsertByUid(store, uid, local, { keepImages: true });
    }
    const nextCursor = Math.max(currentCursor, cursorOf(response?.nextCursor ?? response?.cursor));
    await db.setSyncMeta(SYNC_META_CURSOR, nextCursor);
    emit({ cursor: nextCursor });
    return { changes: changes.length, cursor: nextCursor };
  }

  async function uploadEventScreenshot(event, accepted, response) {
    if (!event?.blobRef) return response;
    const local = await db.getByUid(event.blobRef.storeName, event.blobRef.uid);
    const blob = local?.[event.blobRef.field];
    const type = screenshotType(event);
    const capturedAt = asIso(event.payload?.sourceUpdatedAt ?? event.payload?.queryTime) ?? getNow();
    const sha256 = await sha256Hex(blob);
    const extension = blob.type === "image/png" ? "png" : "jpg";
    await remote.uploadScreenshot(accepted.id, {
      eventId: event.clientMutationId,
      type,
      capturedAt,
      sha256,
      blob,
      filename: `screenshot.${extension}`,
    }, { idempotencyKey: `${event.clientMutationId}-screenshot-${type}` });
    return response;
  }

  async function sendEvent(event, context) {
    if (event.type !== "case.sync") {
      const unsupported = new Error("UNSUPPORTED_OUTBOX_EVENT");
      unsupported.code = "UNSUPPORTED_OUTBOX_EVENT";
      unsupported.retryable = false;
      throw unsupported;
    }
    let response;
    try {
      response = await remote.syncCases({
        batchId: event.clientMutationId,
        items: [syncItem(event, state.accounts)],
      }, { idempotencyKey: context?.idempotencyKey ?? event.clientMutationId });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const details = conflictsOf(error.conflicts?.length ? error.conflicts : error.details);
      throw Object.assign(error, { conflicts: details });
    }
    if (Array.isArray(response?.conflicts) && response.conflicts.length > 0) {
      return { ...response, conflicts: conflictsOf(response.conflicts) };
    }
    const accepted = acceptedCaseFor(event, response);
    if (!accepted) {
      const error = new Error("CASE_SYNC_NOT_ACCEPTED");
      error.code = "CASE_SYNC_NOT_ACCEPTED";
      error.retryable = false;
      throw error;
    }
    await uploadEventScreenshot(event, accepted, response);
    return {
      ...response,
      receipt: {
        caseAccepted: true,
        screenshotStored: Boolean(event.blobRef),
      },
    };
  }

  async function markConflictsNeedsHuman() {
    const conflicts = await outbox.listOutbox({ status: "conflict" });
    for (const event of conflicts) {
      await outbox.markNeedsHuman(event.id, {
        reason: "CONFLICT",
        conflicts: Array.isArray(event.conflicts) ? event.conflicts : [],
      });
    }
    return conflicts.length;
  }

  async function drainOutboxImpl() {
    let unavailableError = null;
    const summary = await outbox.drain({
      limit: 50,
      send: async (event, context) => {
        try {
          return await sendEvent(event, context);
        } catch (error) {
          if (isUnavailable(error) && !unavailableError) unavailableError = error;
          throw error;
        }
      },
    });
    await markConflictsNeedsHuman();
    await refreshOutboxState();
    if (unavailableError) throw unavailableError;
    return summary;
  }

  const refreshAccounts = singleFlight(refreshAccountsImpl);
  const pullChanges = singleFlight(pullChangesImpl);
  const drainOutbox = singleFlight(drainOutboxImpl);

  function markUnavailable(error) {
    const wasOffline = state.status === "offline" || recoveryProbeUsed;
    if (!wasOffline) recoveryProbeUsed = false;
    emit({
      status: "offline",
      message: "服务器不可达，请重试",
      errorCode: errorCode(error),
    });
    if (!batchPaused) {
      batchPaused = true;
      try { onPauseBatch?.(errorCode(error)); } catch { /* host callback is advisory */ }
    }
  }

  function markRecovered() {
    recoveryProbeUsed = false;
    if (batchPaused) {
      batchPaused = false;
      try { onResumeBatch?.("SERVER_RECOVERED"); } catch { /* host callback is advisory */ }
    }
  }

  function syncNow(options = {}) {
    if (runPromise) return runPromise;
    if (!remote) return Promise.resolve(snapshot(state));
    const force = options.force === true;
    if (hidden() && !force) {
      return Promise.resolve(emit({ status: "paused", message: "页面不可见，已暂停同步" }));
    }
    if (state.status === "offline" && !force) recoveryProbeUsed = true;
    const current = Promise.resolve().then(async () => {
      emit({ status: "syncing", message: "", errorCode: null });
      try {
        await refreshOutboxState();
        const health = remote.healthCheck ?? remote.health;
        if (typeof health !== "function") throw new Error("HEALTH_CHECK_UNAVAILABLE");
        await health();
        await refreshAccounts();
        const drain = await drainOutbox();
        const pull = await pullChanges();
        const lastSyncAt = getNow();
        await db.setSyncMeta(SYNC_META_LAST_SYNC, lastSyncAt);
        emit({ status: "online", lastSyncAt, message: "", errorCode: null });
        markRecovered();
        return { ...snapshot(state), pull, drain, status: "online" };
      } catch (error) {
        if (isUnavailable(error)) {
          markUnavailable(error);
          return { ...snapshot(state), status: "offline", errorCode: errorCode(error) };
        }
        emit({ status: "error", message: "同步失败，请检查后重试", errorCode: errorCode(error) });
        return { ...snapshot(state), status: "error", errorCode: errorCode(error) };
      }
    });
    const wrapped = current.finally(() => {
      if (runPromise === wrapped) runPromise = null;
      scheduleNext();
    });
    runPromise = wrapped;
    return runPromise;
  }

  function start({ immediate = true } = {}) {
    if (started) return runPromise ?? Promise.resolve(snapshot(state));
    started = true;
    visibilityHandler = () => {
      clearTimer();
      if (started) scheduleNext();
    };
    document?.addEventListener?.("visibilitychange", visibilityHandler);
    if (immediate) return syncNow();
    scheduleNext();
    return Promise.resolve(snapshot(state));
  }

  function stop() {
    if (!started) return;
    started = false;
    clearTimer();
    if (visibilityHandler) document?.removeEventListener?.("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }

  async function retry() {
    recoveryProbeUsed = false;
    return syncNow({ force: true });
  }

  async function getConflicts() {
    await refreshOutboxState();
    return state.conflicts.map((conflict) => ({ ...conflict }));
  }

  return {
    start,
    stop,
    syncNow,
    sync: syncNow,
    retry,
    pullChanges,
    refreshAccounts,
    drainOutbox,
    getConflicts,
    getState: () => snapshot(state),
    getStatus: () => snapshot(state),
    isPaused: () => state.status === "offline" || state.status === "paused",
  };
}
