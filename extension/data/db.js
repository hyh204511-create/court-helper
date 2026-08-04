// db.js — IndexedDB 数据层
// v2 在既有案件数据上增加同步元数据与 outbox，并在升级时剔除历史 password。
// - store cases / enforcementCases；图片内嵌记录；
// - 唯一键 uid = 账号 + 案号（案号空 → 账号+原告+被告）；
// - upsert 默认保留旧图（批量重查时截图未生成不清空已有凭证）。
export const DB_NAME = "court-helper";
export const DB_VERSION = 2;

export const STORE_CASES = "cases";
export const STORE_ENFORCEMENT = "enforcementCases";
export const STORE_SYNC_META = "syncMeta";
export const STORE_OUTBOX = "outbox";
const CASE_STORES = [STORE_CASES, STORE_ENFORCEMENT];
const STORES = [...CASE_STORES, STORE_SYNC_META, STORE_OUTBOX];
const IMAGE_FIELDS = ["successImage", "rejectImage"];

let _dbPromise = null;

function createCaseStore(db, name) {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath: "uid" });
  store.createIndex("account", "account", { unique: false });
  store.createIndex("status", "status", { unique: false });
}

function createSyncMetaStore(db) {
  if (db.objectStoreNames.contains(STORE_SYNC_META)) return;
  db.createObjectStore(STORE_SYNC_META, { keyPath: "key" });
}

function createOutboxStore(db) {
  if (db.objectStoreNames.contains(STORE_OUTBOX)) return;
  const store = db.createObjectStore(STORE_OUTBOX, { keyPath: "id" });
  store.createIndex("status", "status", { unique: false });
  store.createIndex("nextRetryAt", "nextRetryAt", { unique: false });
  store.createIndex("clientMutationId", "clientMutationId", { unique: true });
}

/** v2 升级脚本必须是幂等的：中断后再次打开仍可继续清理剩余记录。 */
function stripLegacyPasswords(transaction, storeName) {
  if (!transaction.objectStoreNames.contains(storeName)) return;
  const request = transaction.objectStore(storeName).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const value = cursor.value;
    if (value && Object.prototype.hasOwnProperty.call(value, "password")) {
      const cleaned = { ...value };
      delete cleaned.password;
      const update = cursor.update(cleaned);
      update.onsuccess = () => cursor.continue();
      update.onerror = () => transaction.abort();
      return;
    }
    cursor.continue();
  };
  request.onerror = () => transaction.abort();
}

export function openDb() {
  if (!_dbPromise) {
    const promise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const transaction = event.target.transaction;
        for (const name of CASE_STORES) createCaseStore(db, name);
        createSyncMetaStore(db);
        createOutboxStore(db);
        for (const name of CASE_STORES) {
          stripLegacyPasswords(transaction, name);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("DATABASE_BLOCKED"));
    });
    _dbPromise = promise;
    promise.catch(() => {
      if (_dbPromise === promise) _dbPromise = null;
    });
  }
  return _dbPromise;
}

/** 删除数据库（测试与清理用）：先关闭单例连接，避免 deleteDatabase 被 blocked */
export async function resetDb() {
  if (_dbPromise) {
    try {
      const db = await _dbPromise;
      db.close();
    } catch {
      // 失败的打开 promise 已由 openDb 清理，继续删除数据库即可。
    }
    _dbPromise = null;
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** 唯一键：账号+案号；案号空 → 账号+原告+被告 */
export function uidOf(record) {
  const key = record.caseNumber || `${record.plaintiff}\u0000${record.defendant}`;
  return `${record.account}\u0000${key}`;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

function withoutPassword(record) {
  if (!record || typeof record !== "object") return record;
  const cleaned = { ...record };
  delete cleaned.password;
  return cleaned;
}

async function upsertAtUid(storeName, uid, record, { keepImages = true } = {}) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const cleaned = withoutPassword(record);
  store.get(uid).onsuccess = (e) => {
    const existing = e.target.result;
    if (existing && keepImages) {
      for (const f of IMAGE_FIELDS) {
        if (cleaned[f] == null && existing[f] != null) cleaned[f] = existing[f];
      }
    }
    store.put({ ...cleaned, uid, updatedAt: Date.now() });
  };
  await txDone(tx);
  return { ...cleaned, uid };
}

/**
 * 写入/更新记录（按 uid upsert）。
 * @param {string} storeName STORE_CASES | STORE_ENFORCEMENT
 * @param {object} record 记录（图片字段可为 Blob 或 null）
 * @param {{keepImages?: boolean}} [opts] 默认保留已有图片
 */
export async function upsert(storeName, record, { keepImages = true } = {}) {
  const uid = uidOf(record);
  return upsertAtUid(storeName, uid, record, { keepImages });
}

/** 远端 pull 使用服务端的 clientUid 写回，不重新猜测本地 uid。 */
export async function upsertByUid(storeName, uid, record, { keepImages = true } = {}) {
  if (typeof uid !== "string" || uid === "") throw new TypeError("uid required");
  return upsertAtUid(storeName, uid, record, { keepImages });
}

export async function getByUid(storeName, uid) {
  return getByKey(storeName, uid);
}

export async function getByKey(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(storeName, value) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value);
  await txDone(tx);
  return value;
}

export async function deleteByKey(storeName, key) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(key);
  await txDone(tx);
}

export async function getAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getSyncMeta(key) {
  const record = await getByKey(STORE_SYNC_META, key);
  return record?.value;
}

export async function setSyncMeta(key, value) {
  return put(STORE_SYNC_META, { key, value, updatedAt: Date.now() });
}

export async function removeSyncMeta(key) {
  return deleteByKey(STORE_SYNC_META, key);
}

export async function remove(storeName, uid) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(uid);
  await txDone(tx);
}

export async function clearStore(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).clear();
  await txDone(tx);
}

/**
 * 查询（数据量小，全表过滤即可）。
 * @param {string} storeName
 * @param {{account?: string, keyword?: string, status?: string}} [filter]
 *   keyword 模糊匹配 原告/被告/账号
 */
export async function query(storeName, { account, keyword, status } = {}) {
  const all = await getAll(storeName);
  const k = keyword?.trim();
  return all
    .filter((r) => {
      if (account && r.account !== account) return false;
      if (status && r.status !== status) return false;
      if (k && ![r.plaintiff, r.defendant, r.account].some((v) => v?.includes(k))) return false;
      return true;
    })
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

/** 批量导入入库：返回 {imported, updated} */
export async function applyImport(storeName, records) {
  let imported = 0;
  let updated = 0;
  for (const rec of records) {
    const exists = await getByUid(storeName, uidOf(rec));
    await upsert(storeName, rec);
    if (exists) updated += 1;
    else imported += 1;
  }
  return { imported, updated };
}
