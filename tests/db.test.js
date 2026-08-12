import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  STORE_CASES,
  STORE_ENFORCEMENT,
  applyImport,
  clearStore,
  getByUid,
  query,
  replaceAccountRecords,
  remove,
  resetDb,
  uidOf,
  upsert,
} from "../extension/data/db.js";

const IMG = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

function caseRec(over = {}) {
  return {
    account: "TEST-ACCOUNT-001",
    password: "test-pass-001",
    plaintiff: "测试原告甲",
    defendant: "测试被告A",
    status: "审核中",
    filedTime: null,
    caseNumber: null,
    successImage: null,
    rejectTime: null,
    rejectReason: null,
    rejectImage: null,
    queryTime: "2026-08-03",
    ...over,
  };
}

beforeEach(async () => {
  await resetDb();
});

test("uidOf：账号+案号；案号空退化为账号+原告+被告", () => {
  assert.equal(uidOf(caseRec({ caseNumber: "（2026）京0000民初00001号" })),
    "TEST-ACCOUNT-001\u0000（2026）京0000民初00001号");
  assert.equal(uidOf(caseRec()),
    "TEST-ACCOUNT-001\u0000测试原告甲\u0000测试被告A");
});

test("upsert 后 getByUid 读回；同 uid 再 upsert 覆盖并保持唯一", async () => {
  await upsert(STORE_CASES, caseRec());
  const rec = await getByUid(STORE_CASES, uidOf(caseRec()));
  assert.equal(rec.plaintiff, "测试原告甲");
  assert.equal(rec.status, "审核中");

  await upsert(STORE_CASES, caseRec({ status: "立案成功", caseNumber: "（2026）京0000民初00001号" }));
  const updated = await getByUid(STORE_CASES, uidOf(caseRec({ caseNumber: "（2026）京0000民初00001号" })));
  assert.equal(updated.status, "立案成功");
  assert.ok(updated.updatedAt > 0);

  const all = await query(STORE_CASES);
  assert.equal(all.length, 2, "不同 uid 是两条记录");
});

test("query：按账号 / 客户名模糊 / 状态 / 组合过滤", async () => {
  await upsert(STORE_CASES, caseRec({ status: "审核中" }));
  await upsert(STORE_CASES, caseRec({ account: "TEST-ACCOUNT-002", plaintiff: "测试原告乙", status: "已驳回" }));
  await upsert(STORE_ENFORCEMENT, caseRec({ status: "强执成功" }));

  assert.equal((await query(STORE_CASES, { account: "TEST-ACCOUNT-002" })).length, 1);
  assert.equal((await query(STORE_CASES, { keyword: "原告乙" })).length, 1);
  assert.equal((await query(STORE_CASES, { keyword: "TEST-ACCOUNT-001" })).length, 1);
  assert.equal((await query(STORE_CASES, { status: "已驳回" })).length, 1);
  assert.equal((await query(STORE_CASES, { account: "TEST-ACCOUNT-001", status: "已驳回" })).length, 0);
  assert.equal((await query(STORE_ENFORCEMENT, { status: "强执成功" })).length, 1);
});

test("remove 与 clearStore", async () => {
  await upsert(STORE_CASES, caseRec());
  const uid = uidOf(caseRec());
  await remove(STORE_CASES, uid);
  assert.equal(await getByUid(STORE_CASES, uid), undefined);
  await upsert(STORE_CASES, caseRec());
  await clearStore(STORE_CASES);
  assert.equal((await query(STORE_CASES)).length, 0);
});

test("replaceAccountRecords：仅原子替换当前登录账号，保留其他账号的历史数据", async () => {
  await upsert(STORE_CASES, caseRec({ caseNumber: "旧案号" }));
  await upsert(STORE_CASES, caseRec({ account: "TEST-ACCOUNT-002", plaintiff: "测试原告乙", caseNumber: "其他账号案号" }));

  await replaceAccountRecords(STORE_CASES, "TEST-ACCOUNT-001", [
    caseRec({ plaintiff: "平台原告", defendant: "平台被告", caseNumber: "新案号", status: "立案成功" }),
  ]);

  const current = await query(STORE_CASES, { account: "TEST-ACCOUNT-001" });
  assert.equal(current.length, 1);
  assert.equal(current[0].caseNumber, "新案号");
  assert.equal((await query(STORE_CASES, { account: "TEST-ACCOUNT-002" })).length, 1);
});

test("replaceAccountRecords：平台发现替换当前账号时清理同账号的 legacy 记录", async () => {
  const account = "TEST-ACCOUNT-001";
  const platformAccountId = "00000000-0000-4000-8000-000000000001";
  await upsert(STORE_CASES, caseRec({ caseNumber: "legacy-same-account" }));
  await upsert(STORE_CASES, caseRec({
    platformAccountId: "00000000-0000-4000-8000-000000000002",
    caseNumber: "other-platform-account",
  }));

  await replaceAccountRecords(STORE_CASES, account, [caseRec({
    platformAccountId,
    plaintiff: "platform plaintiff",
    defendant: "platform defendant",
    caseNumber: "discovered-case",
  })], { platformAccountId });

  const records = await query(STORE_CASES, { account });
  assert.deepEqual(records.map((record) => record.caseNumber).sort(), ["discovered-case", "other-platform-account"]);
  assert.equal(records.some((record) => record.caseNumber === "legacy-same-account"), false);
});

test("keepImages：重查无新图时保留旧图；显式传新图才覆盖", async () => {
  await upsert(STORE_CASES, caseRec({ status: "立案成功", successImage: IMG() }));
  // 再次查询但截图未生成（null）→ 旧图保留
  await upsert(STORE_CASES, caseRec({ status: "立案成功", successImage: null }));
  let rec = await getByUid(STORE_CASES, uidOf(caseRec()));
  assert.ok(rec.successImage, "旧图应保留");
  // 显式新图 → 覆盖
  const newImg = new Blob([new Uint8Array([9, 9])], { type: "image/jpeg" });
  await upsert(STORE_CASES, caseRec({ status: "立案成功", successImage: newImg }));
  rec = await getByUid(STORE_CASES, uidOf(caseRec()));
  assert.equal(rec.successImage.size, 2);
});

test("replaceAccountRecords：同一来源重查保留已确认字段和图片", async () => {
  const base = caseRec({
    status: "已驳回",
    rejectTime: "2026-08-02",
    rejectReason: "SYNTHETIC REASON",
    rejectImage: IMG(),
  });
  await upsert(STORE_ENFORCEMENT, base);
  await replaceAccountRecords(STORE_ENFORCEMENT, base.account, [{
    ...base,
    status: "UNKNOWN",
    rejectTime: null,
    rejectReason: null,
    rejectImage: null,
  }]);
  const [record] = await query(STORE_ENFORCEMENT, { account: base.account });
  assert.equal(record.status, "已驳回");
  assert.equal(record.rejectTime, "2026-08-02");
  assert.equal(record.rejectReason, "SYNTHETIC REASON");
  assert.ok(record.rejectImage);
});

test("applyImport：新增/更新计数", async () => {
  const a = await applyImport(STORE_CASES, [caseRec(), caseRec({ caseNumber: "（2026）京0000民初00001号" })]);
  assert.deepEqual({ ...a }, { imported: 2, updated: 0 });
  const b = await applyImport(STORE_CASES, [caseRec()]);
  assert.deepEqual({ ...b }, { imported: 0, updated: 1 });
});

test("platform discovery records with the same parties and different causes remain separate", async () => {
  const account = "TEST-ACCOUNT-001";
  await replaceAccountRecords(STORE_CASES, account, [
    caseRec({
      plaintiff: "synthetic plaintiff",
      defendant: "synthetic defendant",
      sourceCaseName: "synthetic title one",
      sourceCause: "synthetic cause one",
      sourceApplicationDate: "2026-08-01",
    }),
    caseRec({
      plaintiff: "synthetic plaintiff",
      defendant: "synthetic defendant",
      sourceCaseName: "synthetic title two",
      sourceCause: "synthetic cause two",
      sourceApplicationDate: "2026-08-02",
    }),
  ]);

  const current = await query(STORE_CASES, { account });
  assert.equal(current.length, 2);
});
