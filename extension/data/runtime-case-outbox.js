import { CASE_SYNC_ENQUEUE } from "../sw/case-sync-bridge.js";

function syncError(response) {
  const code = typeof response?.code === "string" && response.code
    ? response.code
    : "CASE_SYNC_NOT_ACKNOWLEDGED";
  const error = new Error(code);
  error.code = code;
  error.retryable = response?.status === "pending";
  return error;
}

export function createRuntimeCaseOutbox({ sendMessage = globalThis.chrome?.runtime?.sendMessage?.bind(globalThis.chrome.runtime) } = {}) {
  if (typeof sendMessage !== "function") throw new TypeError("sendMessage required");

  return {
    async enqueue(event) {
      const response = await sendMessage({
        type: CASE_SYNC_ENQUEUE,
        event: {
          type: event?.type,
          clientMutationId: event?.clientMutationId,
          payload: event?.payload,
        },
      });
      if (response?.ok !== true || response?.status !== "sent") throw syncError(response);
      return {
        status: "sent",
        clientMutationId: response.clientMutationId,
      };
    },
  };
}
