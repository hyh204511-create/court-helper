import * as defaultDb from "../data/db.js";

export const CASE_SYNC_ENQUEUE = "CASE_SYNC_ENQUEUE";

const COURT_HOST = "zxfw.court.gov.cn";
const TERMINAL_FAILURES = new Set(["conflict", "needs_human"]);
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

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

function evidenceField(payload) {
  if (payload?.status === "已驳回") return "rejectImage";
  if (["立案成功", "强执成功"].includes(payload?.status)) return "successImage";
  return null;
}

function decodeEvidence(evidence, expectedField) {
  if (evidence == null) return null;
  if (!expectedField) {
    throw Object.assign(new TypeError("unexpected terminal evidence"), { code: "SCREENSHOT_BLOB_UNAVAILABLE" });
  }
  if (!evidence || evidence.field !== expectedField
    || !["image/png", "image/jpeg"].includes(evidence.mimeType)
    || typeof evidence.base64 !== "string" || evidence.base64 === "") {
    throw Object.assign(new TypeError("terminal evidence required"), { code: "SCREENSHOT_BLOB_UNAVAILABLE" });
  }
  let binary;
  try {
    binary = globalThis.atob(evidence.base64);
  } catch {
    throw Object.assign(new TypeError("invalid terminal evidence"), { code: "SCREENSHOT_BLOB_UNAVAILABLE" });
  }
  if (binary.length > MAX_SCREENSHOT_BYTES) {
    throw Object.assign(new RangeError("terminal evidence too large"), { code: "SCREENSHOT_TOO_LARGE" });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: evidence.mimeType });
}

export function createCaseSyncBridge({ ensureCoordinator, outbox, db = defaultDb } = {}) {
  if (typeof ensureCoordinator !== "function") throw new TypeError("ensureCoordinator required");
  if (!outbox || typeof outbox.enqueue !== "function" || typeof outbox.getOutbox !== "function") {
    throw new TypeError("outbox required");
  }

  async function handle(message, sender) {
    if (!isCourtSender(sender)) return { ok: false, code: "FORBIDDEN" };
    if (message?.type !== CASE_SYNC_ENQUEUE || !validEvent(message.event)) {
      return { ok: false, code: "VALIDATION_ERROR" };
    }

    const field = evidenceField(message.event.payload);
    const blob = decodeEvidence(message.event.evidence, field);
    let blobRef = null;
    if (blob) {
      const uid = message.event.payload.clientUid;
      if (typeof uid !== "string" || uid === "") return { ok: false, code: "VALIDATION_ERROR" };
      const storeName = message.event.payload.kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
      const existing = await db.getByUid(storeName, uid);
      await db.upsertByUid(storeName, uid, { ...existing, [field]: blob }, { keepImages: true });
      blobRef = { storeName, uid, field };
    }

    const input = {
      type: "case.sync",
      clientMutationId: message.event.clientMutationId,
      payload: message.event.payload,
      // Content-script IndexedDB belongs to the court page. The evidence bytes
      // are copied into the worker's IndexedDB, while the durable event keeps
      // only this local reference and never stores image bytes in its payload.
      blobRef,
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
