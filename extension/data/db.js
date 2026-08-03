// db.js — IndexedDB 数据层
// 依据 docs/specs/excel-module.md §2：
// - store cases / enforcementCases；图片内嵌记录；
// - 唯一键 uid = 账号 + 案号（案号空 → 账号+原告+被告）；
// - upsert 默认保留旧图（批量重查时截图未生成不清空已有凭证）。
const DB_NAME = "court-helper";
const DB_VERSION = 1;

export const STORE_CASES = "cases";
export const STORE_ENFORCEMENT = "enforcementCases";
const STORES = [STORE_CASES, STORE_ENFORCEMENT];
const IMAGE_FIELDS = ["successImage", "rejectImage"];

let _dbPromise = null;

export function openDb() {
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: "uid" });
            store.createIndex("account", "account", { unique: false });
            store.createIndex("status", "status", { unique: false });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _dbPromise;
}

/** 删除数据库（测试与清理用）：先关闭单例连接，避免 deleteDatabase 被 blocked */
export async function resetDb() {
  if (_dbPromise) {
    const db = await _dbPromise;
    db.close();
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

/**
 * 写入/更新记录（按 uid upsert）。
 * @param {string} storeName STORE_CASES | STORE_ENFORCEMENT
 * @param {object} record 记录（图片字段可为 Blob 或 null）
 * @param {{keepImages?: boolean}} [opts] 默认保留已有图片
 */
export async function upsert(storeName, record, { keepImages = true } = {}) {
  const db = await openDb();
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  const uid = uidOf(record);
  store.get(uid).onsuccess = (e) => {
    const existing = e.target.result;
    if (existing && keepImages) {
      for (const f of IMAGE_FIELDS) {
        if (record[f] == null && existing[f] != null) record[f] = existing[f];
      }
    }
    store.put({ ...record, uid, updatedAt: Date.now() });
  };
  await txDone(tx);
  return { ...record, uid };
}

export async function getByUid(storeName, uid) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(uid);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
