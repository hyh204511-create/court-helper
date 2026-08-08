import assert from "node:assert/strict";
import { test } from "node:test";

import { selectMyCaseApiEvidence, selectMyCaseEvidence } from "../extension/data/platform-evidence.js";

const successfulLiRecord = {
  uid: "li-platform-record",
  kind: "li",
  account: "masked-platform-account",
  platformAccountId: "00000000-0000-4000-8000-000000000001",
  sourceCaseName: "platform-source-title",
  status: "立案成功",
};

function civilSuccess(overrides = {}) {
  return {
    statusText: "审理中",
    caseType: "民事案件",
    caseName: successfulLiRecord.sourceCaseName,
    fields: [
      { label: "案号", value: "SYNTHETIC-LI-001" },
      { label: "立案日期", value: "2026-08-07" },
    ],
    ...overrides,
  };
}

test("我的案件成功取证：只接受平台搜索返回的一条、同类型、精确成功且字段完整的行", () => {
  const result = selectMyCaseEvidence({ record: successfulLiRecord, kind: "li", rows: [civilSuccess()] });
  assert.deepEqual(result, {
    ok: true,
    value: { uid: "li-platform-record", caseNumber: "SYNTHETIC-LI-001", filedTime: "2026-08-07" },
  });
});

test("我的案件成功取证：结果不唯一、类型、状态或字段不符时不补 F/G", () => {
  for (const [rows, error] of [
    [[], "MYCASE_EVIDENCE_UNAVAILABLE"],
    [[civilSuccess(), civilSuccess()], "MYCASE_EVIDENCE_AMBIGUOUS"],
    [[civilSuccess({ caseType: "执行类案件" })], "MYCASE_EVIDENCE_UNAVAILABLE"],
    [[civilSuccess({ statusText: "调解中" })], "MYCASE_EVIDENCE_UNAVAILABLE"],
    [[civilSuccess({ fields: [{ label: "案号", value: "SYNTHETIC-LI-001" }] })], "MYCASE_EVIDENCE_UNAVAILABLE"],
  ]) {
    assert.deepEqual(selectMyCaseEvidence({ record: successfulLiRecord, kind: "li", rows }), { ok: false, error });
  }
});

test("我的案件成功取证：同一原被告和案由存在历史案件时选唯一最新立案日期", () => {
  const result = selectMyCaseEvidence({
    record: successfulLiRecord,
    kind: "li",
    rows: [
      civilSuccess({ fields: [
        { label: "案号", value: "SYNTHETIC-LI-OLD" },
        { label: "立案日期", value: "2026-08-01" },
      ] }),
      civilSuccess({ fields: [
        { label: "案号", value: "SYNTHETIC-LI-LATEST" },
        { label: "立案日期", value: "2026-08-07" },
      ] }),
    ],
  });
  assert.deepEqual(result, {
    ok: true,
    value: { uid: "li-platform-record", caseNumber: "SYNTHETIC-LI-LATEST", filedTime: "2026-08-07" },
  });
});

test("我的案件成功取证：最新立案日期并列时保持歧义待人工", () => {
  const result = selectMyCaseEvidence({
    record: successfulLiRecord,
    kind: "li",
    rows: [civilSuccess(), civilSuccess({ fields: [
      { label: "案号", value: "SYNTHETIC-LI-002" },
      { label: "立案日期", value: "2026-08-07" },
    ] })],
  });
  assert.deepEqual(result, { ok: false, error: "MYCASE_EVIDENCE_AMBIGUOUS" });
});

test("我的案件成功取证：平台搜索的唯一结果标题不全等时也不得补 F/G", () => {
  const result = selectMyCaseEvidence({
    record: successfulLiRecord,
    kind: "li",
    rows: [civilSuccess({ caseName: "different title containing source title" })],
  });
  assert.deepEqual(result, { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" });
});

const apiRecord = {
  ...successfulLiRecord,
  plaintiff: "SYNTHETIC PLAINTIFF",
  defendant: "SYNTHETIC DEFENDANT",
  sourceCause: "SYNTHETIC CAUSE",
};
const sourceApiRow = {
  sfBh: "SYNTHETIC-ACCOUNT-ID",
  fyid: "SYNTHETIC-COURT-ID",
  ajlx: "SYNTHETIC-TYPE-ID",
  laay: apiRecord.sourceCause,
  updateTime: "2026-08-07T08:30:00Z",
};
function apiEvidence(overrides = {}) {
  return {
    csfid: sourceApiRow.sfBh,
    nfydm: sourceApiRow.fyid,
    cywlx: sourceApiRow.ajlx,
    claay: sourceApiRow.laay,
    clarq: "2026-08-07",
    cajmc: "SYNTHETIC PLAINTIFF与SYNTHETIC EXTRA,SYNTHETIC DEFENDANTSYNTHETIC CAUSE一案",
    cah: "SYNTHETIC-LI-API-001",
    ...overrides,
  };
}

test("ajlist 成功补证使用跨接口严格结构，不要求两个页面标题全等且不跳转 DOM", () => {
  assert.deepEqual(selectMyCaseApiEvidence({
    record: apiRecord,
    sourceApiRow,
    rows: [apiEvidence()],
  }), {
    ok: true,
    value: { uid: apiRecord.uid, caseNumber: "SYNTHETIC-LI-API-001", filedTime: "2026-08-07" },
  });
});

test("ajlist 补证缺少任一结构键或出现重复候选时转人工", () => {
  for (const row of [
    apiEvidence({ csfid: "OTHER" }),
    apiEvidence({ nfydm: "OTHER" }),
    apiEvidence({ cywlx: "OTHER" }),
    apiEvidence({ claay: "OTHER" }),
    apiEvidence({ clarq: "2026-08-08" }),
    apiEvidence({ cajmc: "SYNTHETIC PLAINTIFF与OTHER SYNTHETIC CAUSE一案" }),
    apiEvidence({ cah: "" }),
  ]) {
    assert.deepEqual(selectMyCaseApiEvidence({ record: apiRecord, sourceApiRow, rows: [row] }), {
      ok: false,
      error: "MYCASE_EVIDENCE_UNAVAILABLE",
    });
  }
  assert.deepEqual(selectMyCaseApiEvidence({
    record: apiRecord,
    sourceApiRow,
    rows: [apiEvidence(), apiEvidence({ cah: "SYNTHETIC-LI-API-002" })],
  }), { ok: false, error: "MYCASE_EVIDENCE_AMBIGUOUS" });
});
