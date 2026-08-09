export const CASE_SYNC_ENQUEUE = "CASE_SYNC_ENQUEUE";

const COURT_HOST = "zxfw.court.gov.cn";
const TERMINAL_FAILURES = new Set(["conflict", "needs_human"]);

function isCourtSender(sender) {
  try {
    return new URL(sender?.tab?.url).hostname === COURT_HOST;
  } catch {
    return false;
  }
}

function validEvent(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.type === "case.sync"
    && typeof value.clientMutationId === "string"
    && value.clientMutationId.trim() !== ""
    && value.payload
    && typeof value.payload === "object"
    && !Array.isArray(value.payload);
}

function failure(event, fallbackCode = "CASE_SYNC_NOT_ACKNOWLEDGED") {
  return {
    ok: false,
    code: typeof event?.lastErrorCode === "string" && event.lastErrorCode
      ? event.lastErrorCode
      : fallbackCode,
    status: event?.status ?? "pending",
  };
}

export function createCaseSyncBridge({ ensureCoordinator, outbox } = {}) {
  if (typeof ensureCoordinator !== "function") throw new TypeError("ensureCoordinator required");
  if (!outbox || typeof outbox.enqueue !== "function" || typeof outbox.getOutbox !== "function") {
    throw new TypeError("outbox required");
  }

  async function handle(message, sender) {
    if (!isCourtSender(sender)) return { ok: false, code: "FORBIDDEN" };
    if (message?.type !== CASE_SYNC_ENQUEUE || !validEvent(message.event)) {
      return { ok: false, code: "VALIDATION_ERROR" };
    }

    const input = {
      type: "case.sync",
      clientMutationId: message.event.clientMutationId,
      payload: message.event.payload,
      // Content-script IndexedDB belongs to a different execution context. A
      // page-local Blob reference must never be persisted in the worker queue.
      blobRef: null,
    };
    const queued = await outbox.enqueue(input);
    if (queued.status === "sent") {
      return { ok: true, status: "sent", clientMutationId: queued.clientMutationId };
    }
    if (TERMINAL_FAILURES.has(queued.status)) return failure(queued);

    const coordinator = await ensureCoordinator();
    if (!coordinator || typeof coordinator.retry !== "function") {
      return failure(queued, "NOT_CONFIGURED");
    }
    if (typeof outbox.retry === "function") await outbox.retry(queued.id);
    const syncState = await coordinator.retry();
    const current = await outbox.getOutbox(queued.id);
    if (current?.status === "sent") {
      return { ok: true, status: "sent", clientMutationId: current.clientMutationId };
    }
    return failure(current ?? queued, syncState?.errorCode);
  }

  return {
    canHandle(message) {
      return message?.type === CASE_SYNC_ENQUEUE;
    },
    handle,
  };
}
