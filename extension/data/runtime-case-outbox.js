import { CASE_SYNC_ENQUEUE } from "../sw/case-sync-bridge.js";
import * as defaultDb from "./db.js";

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

function syncError(response) {
  const code = typeof response?.code === "string" && response.code
    ? response.code
    : "CASE_SYNC_NOT_ACKNOWLEDGED";
  const error = new Error(code);
  error.code = code;
  error.retryable = response?.status === "pending";
  return error;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

async function readEvidence(event, db) {
  const ref = event?.blobRef;
  if (!ref) return null;
  if (!["successImage", "rejectImage"].includes(ref.field)) {
    throw Object.assign(new TypeError("invalid evidence field"), { code: "SCREENSHOT_BLOB_UNAVAILABLE" });
  }
  const local = await db.getByUid(ref.storeName, ref.uid);
  const blob = local?.[ref.field];
  if (typeof blob?.arrayBuffer !== "function" || !/^image\/(?:png|jpeg)$/.test(blob.type)) {
    throw Object.assign(new Error("SCREENSHOT_BLOB_UNAVAILABLE"), { code: "SCREENSHOT_BLOB_UNAVAILABLE" });
  }
  if (blob.size > MAX_SCREENSHOT_BYTES) {
    throw Object.assign(new RangeError("terminal evidence too large"), { code: "SCREENSHOT_TOO_LARGE" });
  }
  return {
    field: ref.field,
    mimeType: blob.type,
    base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
  };
}

export function createRuntimeCaseOutbox({
  sendMessage = globalThis.chrome?.runtime?.sendMessage?.bind(globalThis.chrome.runtime),
  db = defaultDb,
} = {}) {
  if (typeof sendMessage !== "function") throw new TypeError("sendMessage required");

  return {
    async enqueue(event) {
      const evidence = await readEvidence(event, db);
      const response = await sendMessage({
        type: CASE_SYNC_ENQUEUE,
        event: {
          type: event?.type,
          clientMutationId: event?.clientMutationId,
          payload: event?.payload,
          ...(evidence ? { evidence } : {}),
        },
      });
      if (response?.ok !== true || response?.status !== "sent" || response?.evidenceClosed !== true) {
        if (response?.ok === true && response?.status === "sent") {
          throw syncError({ ...response, code: "EVIDENCE_NOT_CLOSED" });
        }
        throw syncError(response);
      }
      return {
        status: "sent",
        clientMutationId: response.clientMutationId,
        evidenceClosed: true,
      };
    },
  };
}
