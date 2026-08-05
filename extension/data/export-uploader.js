const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (typeof value?.arrayBuffer === "function") return value.arrayBuffer();
  throw Object.assign(new TypeError("export buffer required"), { code: "EXPORT_BUFFER_REQUIRED" });
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function failureCode(error, fallback = "UPLOAD_FAILED") {
  return typeof error?.code === "string" && error.code ? error.code : fallback;
}

function normalizeResponse(response) {
  if (response?.ok === true) {
    return {
      status: "uploaded",
      ...(typeof response.exportId === "string" ? { exportId: response.exportId } : {}),
    };
  }
  if (response?.code === "NOT_CONFIGURED") {
    return { status: "not_configured", code: "NOT_CONFIGURED" };
  }
  return { status: "failed", code: failureCode(response, "UPLOAD_FAILED") };
}

/**
 * 本地下载完成后尽力上传报表；所有失败均转为回执，不向调用方抛出。
 * @param {{buffer?: ArrayBuffer|ArrayBufferView|Blob, blob?: Blob, fileName: string, chromeApi?: object, cryptoImpl?: object}} options
 * @returns {Promise<{status: 'uploaded'|'not_configured'|'failed', exportId?: string, code?: string}>}
 */
export async function exportWorkbookToServer({
  buffer,
  blob,
  fileName,
  chromeApi = globalThis.chrome,
  cryptoImpl = globalThis.crypto,
} = {}) {
  try {
    if (blob == null && buffer == null) {
      throw Object.assign(new TypeError("export buffer required"), { code: "EXPORT_BUFFER_REQUIRED" });
    }
    const payload = blob ?? new Blob([buffer], { type: XLSX_MIME });
    const data = await bytesOf(payload);
    const subtle = cryptoImpl?.subtle ?? cryptoImpl;
    if (typeof subtle?.digest !== "function") {
      throw Object.assign(new Error("crypto unavailable"), { code: "CRYPTO_UNAVAILABLE" });
    }
    const digest = await subtle.digest("SHA-256", data);
    const response = await chromeApi?.runtime?.sendMessage?.({
      type: "EXPORT_UPLOAD",
      fileName: String(fileName || "report.xlsx"),
      sha256: toHex(digest),
      blob: payload,
    });
    return normalizeResponse(response);
  } catch (error) {
    return { status: "failed", code: failureCode(error) };
  }
}

export function exportUploadMessage(result = {}) {
  if (result.status === "uploaded") return "已上传服务器，后台可再次下载";
  if (result.status === "not_configured") return "未配置服务器，仅本地保存";
  return "上传失败，本地文件已保存";
}
