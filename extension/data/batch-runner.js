// batch-runner.js — 批量任务执行器（调度核心，依赖注入 pageOps）
// 依据 app-module 规格：
// - 单批上限 50；相邻案件节流 3–8s 随机；失败重试 1 次后标记待人工；
// - 状态识别禁猜（UNKNOWN → needsHuman）；成功/驳回自动截图；
// - pageOps 由浏览器端实现（content script 操作真实页面），测试注入 mock。
import { recognizeStatus } from "../content/status-recognizer.js";
import * as defaultDb from "./db.js";
import * as defaultOutbox from "./outbox.js";

export const BATCH_LIMIT = 50;
export const RETRY_COUNT = 1;
export const THROTTLE_MIN_MS = 3000;
export const THROTTLE_MAX_MS = 8000;

export function jitterMs(min = THROTTLE_MIN_MS, max = THROTTLE_MAX_MS) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当天日期 YYYY-MM-DD（本地时区） */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 需要截图的模板状态（成功图片/驳回图片） */
const NEEDS_IMAGE = new Set(["立案成功", "强执成功", "已驳回"]);

function stableErrorCode(value) {
  if (typeof value !== "string" || value === "") return null;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "QUERY_FAILED";
}

function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 本地结果先落库，再进入远端 outbox；图片只保留本地引用，不进 JSON 载荷。
 * `persistence` 可注入测试替身，默认仅在浏览器存在 IndexedDB 时启用。
 */
export async function persistSyncRecord(record, { db = defaultDb, outbox = defaultOutbox } = {}) {
  const storeName = record.kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const uid = typeof record.uid === "string" && record.uid ? record.uid : db.uidOf(record);
  const existing = await db.getByUid(storeName, uid);
  const queryFailed = record.status === "UNKNOWN" && stableErrorCode(record.error ?? record.errorCode) !== null;
  const status = queryFailed && existing?.status ? existing.status : record.status;
  const successImage = record.successImage
    ?? (status !== "已驳回" ? record.image : null)
    ?? existing?.successImage
    ?? null;
  const rejectImage = record.rejectImage
    ?? (status === "已驳回" ? record.image : null)
    ?? existing?.rejectImage
    ?? null;
  const evidenceValue = (field) => record[field]
    ?? existing?.[field]
    ?? (Object.prototype.hasOwnProperty.call(record, field) ? null : undefined);
  const local = await db.upsertByUid(storeName, uid, {
    ...existing,
    ...record,
    status,
    filedTime: evidenceValue("filedTime"),
    caseNumber: evidenceValue("caseNumber"),
    rejectTime: evidenceValue("rejectTime"),
    rejectReason: evidenceValue("rejectReason"),
    successImage,
    rejectImage,
    needsHuman: record.needsHuman
      || (!successImage && ["立案成功", "强执成功"].includes(status))
      || (!rejectImage && status === "已驳回"),
  });
  const payload = {
    clientUid: local.uid,
    account: local.account ?? record.account ?? "",
    platformAccountId: record.platformAccountId ?? local.platformAccountId ?? "",
    kind: local.kind,
    plaintiff: local.plaintiff ?? "",
    defendant: local.defendant ?? "",
    status: local.status,
    filedTime: local.filedTime ?? null,
    caseNumber: local.caseNumber ?? null,
    rejectTime: local.rejectTime ?? null,
    rejectReason: local.rejectReason ?? null,
    queryTime: local.queryTime ?? null,
    needsHuman: local.needsHuman === true,
    errorCode: stableErrorCode(local.errorCode ?? local.error),
    sourceUpdatedAt: new Date(local.updatedAt ?? Date.now()).toISOString(),
  };
  const mutationId = `case-${fingerprint(payload)}`;
  await outbox.enqueue({
    type: "case.sync",
    clientMutationId: mutationId,
    payload,
    blobRef: (local.status === "已驳回" ? local.rejectImage : local.successImage)?.arrayBuffer
      ? {
          storeName,
          uid,
          field: local.status === "已驳回" ? "rejectImage" : "successImage",
        }
      : null,
  });
  return local;
}

/**
 * 执行批量查询。
 * @param {object} opts
 * @param {Array<{uid: string, account?: string, kind?: 'li'|'qz', plaintiff?: string}>} opts.cases
 * @param {object} opts.pageOps 页面操作器（浏览器端注入）：queryCase({uid, kind}) → raw，capture() → 图片数据
 * @param {(record: object) => void} [opts.onUpdate] 每条结果回调（供持久化）
 * @param {object} [opts.timing] {delay: () => Promise} 可注入节流（测试传空）
 * @returns {Promise<{total: number, success: number, unknown: number, needsHuman: number}>}
 */
export async function runBatch({ cases = [], pageOps, onUpdate, timing = {}, persistence } = {}) {
  const delay = timing.delay ?? (() => sleep(jitterMs()));
  const queue = cases.slice(0, BATCH_LIMIT);
  const stats = { total: queue.length, success: 0, unknown: 0, needsHuman: 0 };
  const syncPersistence = persistence ?? (typeof indexedDB !== "undefined"
    ? { db: defaultDb, outbox: defaultOutbox }
    : null);

  for (const c of queue) {
    let raw = null;
    let error = null;
    for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
      try {
        raw = await pageOps.queryCase({ uid: c.uid, kind: c.kind });
        error = null;
        break;
      } catch (e) {
        error = e;
        if (attempt < RETRY_COUNT) await delay();
      }
    }

    const record = {
      uid: c.uid,
      kind: c.kind ?? "li",
      account: c.account ?? "",
      platformAccountId: c.platformAccountId ?? "",
      plaintiff: c.plaintiff ?? "",
      status: "UNKNOWN",
      caseNumber: null,
      filedTime: null,
      rejectTime: null,
      rejectReason: null,
      successImage: null,
      rejectImage: null,
      image: null,
      queryTime: today(),
      needsHuman: false,
      error: null,
    };

    if (raw) {
      const status = recognizeStatus({
        statusText: raw.statusText,
        caseType: raw.caseType,
        pageKind: raw.pageKind,
      });
      record.status = status;
      record.caseNumber = raw.caseNumber ?? null;
      record.filedTime = raw.filedTime ?? raw.filedDate ?? null;
      record.rejectTime = raw.rejectTime ?? null;
      record.rejectReason = raw.rejectReason ?? null;
      if (status === "UNKNOWN") {
        record.needsHuman = true;
      } else if (NEEDS_IMAGE.has(status)) {
        try {
          const image = status === "已驳回"
            ? raw.rejectImage ?? raw.image ?? (await pageOps.capture())
            : raw.successImage ?? raw.image ?? (await pageOps.capture());
          record.image = image ?? null;
          if (status === "已驳回") record.rejectImage = record.image;
          else record.successImage = record.image;
          if (!record.image) {
            record.needsHuman = true;
            record.error = raw.evidenceError ?? "SCREENSHOT_CAPTURE_FAILED";
          }
        } catch {
          record.needsHuman = true; // 截图失败 → 待人工补图
          record.error = raw.evidenceError ?? "SCREENSHOT_CAPTURE_FAILED";
        }
      }
    } else {
      record.needsHuman = true;
      record.error = error?.message ?? "QUERY_FAILED";
    }

    if (record.status === "UNKNOWN" || record.needsHuman) stats.needsHuman += 1;
    if (record.status === "UNKNOWN") stats.unknown += 1;
    if (record.status !== "UNKNOWN" && !record.needsHuman) stats.success += 1;

    if (syncPersistence) await persistSyncRecord(record, syncPersistence);
    await onUpdate?.(record);
    await delay();
  }

  return stats;
}
