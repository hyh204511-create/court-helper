import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  DB_NAME,
  DB_VERSION,
  STORE_CASES,
  STORE_ENFORCEMENT,
  STORE_OUTBOX,
  STORE_SYNC_META,
  getByUid,
  openDb,
  resetDb,
  uidOf,
  upsert,
} from "../extension/data/db.js";

function openVersionOne() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [STORE_CASES, STORE_ENFORCEMENT]) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "uid" });
          store.createIndex("account", "account", { unique: false });
          store.createIndex("status", "status", { unique: false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function seedV1(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CASES, STORE_ENFORCEMENT], "readwrite");
    const record = {
      uid: "account-1\u0000case-1",
      account: "account-1",
      password: "legacy-password",
      plaintiff: "plaintiff-1",
      defendant: "defendant-1",
      caseNumber: "case-1",
      status: "审核中",
    };
    tx.objectStore(STORE_CASES).put(record);
    tx.objectStore(STORE_ENFORCEMENT).put({ ...record, uid: "account-2\u0000case-2" });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await resetDb();
});

test("v2 迁移新增 syncMeta/outbox，并字段级清理历史 password", async () => {
  const legacyDb = await openVersionOne();
  await seedV1(legacyDb);
  legacyDb.close();

  const db = await openDb();
  assert.equal(DB_VERSION, 2);
  assert.equal(db.version, 2);
  assert.equal(db.objectStoreNames.contains(STORE_SYNC_META), true);
  assert.equal(db.objectStoreNames.contains(STORE_OUTBOX), true);

  const li = await getByUid(STORE_CASES, "account-1\u0000case-1");
  const qz = await getByUid(STORE_ENFORCEMENT, "account-2\u0000case-2");
  assert.equal(li.password, undefined);
  assert.equal(qz.password, undefined);
  assert.equal(li.plaintiff, "plaintiff-1");
  assert.equal(qz.defendant, "defendant-1");
});

test("v2 迁移可重复打开且新写入不保存 password", async () => {
  await openDb();
  const reopened = await openDb();
  assert.equal(reopened.version, 2);

  const record = {
    account: "account-1",
    password: "new-password",
    plaintiff: "plaintiff-1",
    defendant: "defendant-1",
    caseNumber: "case-1",
    status: "审核中",
  };
  const uid = uidOf(record);
  await upsert(STORE_CASES, record);
  assert.equal((await getByUid(STORE_CASES, uid)).password, undefined);
});
