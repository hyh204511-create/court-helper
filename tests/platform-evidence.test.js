import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evidenceFailureCode,
  preferEvidenceError,
  selectMyCaseApiEvidence,
  selectMyCaseEvidence,
  selectSourceApiRow,
} from "../extension/data/platform-evidence.js";

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
  fyid: "SYNTHETIC-SOURCE-COURT-ID",
  fymc: "SYNTHETIC COURT",
  ajlx: "SYNTHETIC-TYPE-ID",
  laay: apiRecord.sourceCause,
  updateTime: "2026-08-07T08:30:00Z",
};
function apiEvidence(overrides = {}) {
  return {
    csfid: sourceApiRow.sfBh,
    nfydm: "SYNTHETIC-TARGET-COURT-CODE",
    cfydmTranslateText: sourceApiRow.fymc,
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

test("ajlist 强执补证接受强执成功记录并沿用严格结构", () => {
  const record = { ...apiRecord, uid: "qz-api-record", status: "强执成功" };
  assert.deepEqual(selectMyCaseApiEvidence({
    kind: "qz",
    record,
    sourceApiRow,
    rows: [apiEvidence({ cah: "SYNTHETIC-QZ-API-001" })],
  }), {
    ok: true,
    value: { uid: record.uid, caseNumber: "SYNTHETIC-QZ-API-001", filedTime: "2026-08-07" },
  });
});

test("ajlist 强执来源缺少 updateTime 时仍按其余严格结构唯一读取成功时间和案号", () => {
  const record = { ...apiRecord, uid: "qz-api-no-update-time", status: "强执成功" };
  const source = { ...sourceApiRow };
  delete source.updateTime;
  assert.deepEqual(selectMyCaseApiEvidence({
    kind: "qz",
    record,
    sourceApiRow: source,
    rows: [apiEvidence({ cah: "SYNTHETIC-QZ-NO-UPDATE-001" })],
  }), {
    ok: true,
    value: { uid: record.uid, caseNumber: "SYNTHETIC-QZ-NO-UPDATE-001", filedTime: "2026-08-07" },
  });
});

test("ajlist 强执 updateTime 与 clarq 不同仍读取强执成功时间和案号", () => {
  const record = { ...apiRecord, uid: "qz-api-different-update-time", status: "强执成功" };
  assert.deepEqual(selectMyCaseApiEvidence({
    kind: "qz",
    record,
    sourceApiRow: { ...sourceApiRow, updateTime: "2026-08-12T08:30:00Z" },
    rows: [apiEvidence({ cah: "SYNTHETIC-QZ-DATE-DIFF-001", clarq: "2026-08-07" })],
  }), {
    ok: true,
    value: { uid: record.uid, caseNumber: "SYNTHETIC-QZ-DATE-DIFF-001", filedTime: "2026-08-07" },
  });
});

test("ajlist 立案 updateTime 与 clarq 不同仍读取立案成功时间和案号", () => {
  assert.deepEqual(selectMyCaseApiEvidence({
    record: apiRecord,
    sourceApiRow: { ...sourceApiRow, updateTime: "2026-08-12T08:30:00Z" },
    rows: [apiEvidence({ cah: "SYNTHETIC-LI-DATE-DIFF-001", clarq: "2026-08-07" })],
  }), {
    ok: true,
    value: { uid: apiRecord.uid, caseNumber: "SYNTHETIC-LI-DATE-DIFF-001", filedTime: "2026-08-07" },
  });
});

test("ajlist 强执案由暂无时由其余结构键与完整标题唯一补证", () => {
  const record = {
    ...apiRecord,
    uid: "qz-api-no-cause-record",
    status: "强执成功",
    plaintiff: "SYNTHETIC APPLICANT",
    defendant: "SYNTHETIC RESPONDENT",
    sourceCause: "暂无",
    sourceCaseName: "SYNTHETIC APPLICANT与SYNTHETIC RESPONDENT首次执行一案",
  };
  const source = { ...sourceApiRow, laay: "", cause: "暂无" };
  const row = apiEvidence({
    claay: "",
    cajmc: record.sourceCaseName,
    cah: "SYNTHETIC-QZ-NO-CAUSE-001",
  });

  assert.deepEqual(selectMyCaseApiEvidence({ kind: "qz", record, sourceApiRow: source, rows: [row] }), {
    ok: true,
    value: { uid: record.uid, caseNumber: "SYNTHETIC-QZ-NO-CAUSE-001", filedTime: "2026-08-07" },
  });
});

test("ajlist 补证前置字段缺失返回具体且安全的诊断码", () => {
  const cases = [
    [{ record: null, sourceApiRow, rows: [] }, "MYCASE_RECORD_MISSING"],
    [{ record: { ...apiRecord, uid: "" }, sourceApiRow, rows: [] }, "MYCASE_RECORD_UID_MISSING"],
    [{ record: { ...apiRecord, status: "审核中" }, sourceApiRow, rows: [] }, "MYCASE_STATUS_MISMATCH"],
    [{ record: apiRecord, sourceApiRow: null, rows: [] }, "SOURCE_API_ROW_MISSING"],
    [{ record: apiRecord, sourceApiRow, rows: null }, "MYCASE_ROWS_INVALID"],
    [{ record: { ...apiRecord, plaintiff: "" }, sourceApiRow, rows: [] }, "SOURCE_PLAINTIFF_MISSING"],
    [{ record: { ...apiRecord, defendant: "" }, sourceApiRow, rows: [] }, "SOURCE_DEFENDANT_MISSING"],
    [{ record: { ...apiRecord, sourceCause: "" }, sourceApiRow, rows: [] }, "SOURCE_CAUSE_MISSING"],
    [{ record: apiRecord, sourceApiRow: { ...sourceApiRow, laay: "OTHER" }, rows: [] }, "SOURCE_CAUSE_MISMATCH"],
    [{ record: apiRecord, sourceApiRow: { ...sourceApiRow, sfBh: "" }, rows: [] }, "SOURCE_ACCOUNT_MISSING"],
    [{ record: apiRecord, sourceApiRow: { ...sourceApiRow, fymc: "" }, rows: [] }, "SOURCE_COURT_MISSING"],
    [{ record: apiRecord, sourceApiRow: { ...sourceApiRow, ajlx: "" }, rows: [] }, "SOURCE_TYPE_MISSING"],
  ];
  for (const [input, error] of cases) {
    assert.deepEqual(selectMyCaseApiEvidence(input), { ok: false, error }, error);
    assert.match(error, /^[A-Z][A-Z0-9_]{0,63}$/);
  }
});

test("ajlist 无候选时按账号、法院、类型、案由、日期、当事人标题逐阶段诊断", () => {
  for (const [row, error] of [
    [apiEvidence({ csfid: "OTHER" }), "MYCASE_ACCOUNT_MISMATCH"],
    [apiEvidence({ cfydmTranslateText: "OTHER" }), "MYCASE_COURT_MISMATCH"],
    [apiEvidence({ cywlx: "OTHER" }), "MYCASE_TYPE_MISMATCH"],
    [apiEvidence({ claay: "OTHER" }), "MYCASE_CAUSE_MISMATCH"],
    [apiEvidence({ cajmc: "SYNTHETIC PLAINTIFF与OTHER SYNTHETIC CAUSE一案" }), "MYCASE_PARTIES_TITLE_MISMATCH"],
  ]) {
    assert.deepEqual(selectMyCaseApiEvidence({ record: apiRecord, sourceApiRow, rows: [row] }), {
      ok: false,
      error,
    }, error);
  }
});

test("ajlist 唯一候选缺少案号返回具体码，多候选仍保持 ambiguous", () => {
  assert.deepEqual(selectMyCaseApiEvidence({
    record: apiRecord,
    sourceApiRow,
    rows: [apiEvidence({ cah: "" })],
  }), { ok: false, error: "MYCASE_CASE_NUMBER_MISSING" });
  assert.deepEqual(selectMyCaseApiEvidence({
    record: apiRecord,
    sourceApiRow,
    rows: [apiEvidence(), apiEvidence({ cah: "SYNTHETIC-LI-API-002" })],
  }), { ok: false, error: "MYCASE_EVIDENCE_AMBIGUOUS" });
});

test("结构化补证回执保留具体安全错误码，仅在无具体原因时使用通用码", () => {
  assert.equal(evidenceFailureCode({
    selection: { ok: false, error: "API_SCHEMA_DRIFT" },
    updated: { needsHuman: true, errorCode: "MYCASE_EVIDENCE_UNAVAILABLE" },
  }), "API_SCHEMA_DRIFT");
  assert.equal(evidenceFailureCode({
    selection: { ok: true },
    updated: { needsHuman: true, errorCode: "SCREENSHOT_CAPTURE_FAILED" },
  }), "SCREENSHOT_CAPTURE_FAILED");
  assert.equal(evidenceFailureCode({ selection: { ok: false }, updated: { needsHuman: true } }), "MYCASE_EVIDENCE_UNAVAILABLE");
  assert.equal(evidenceFailureCode({ selection: { ok: true }, updated: { needsHuman: false } }), null);
  assert.equal(preferEvidenceError("MYCASE_EVIDENCE_UNAVAILABLE", "API_SCHEMA_DRIFT"), "API_SCHEMA_DRIFT");
  assert.equal(preferEvidenceError("API_SCHEMA_DRIFT", "MYCASE_EVIDENCE_UNAVAILABLE"), "API_SCHEMA_DRIFT");
});

test("layy 来源行回绑逐字段返回安全诊断码且要求唯一", () => {
  const record = {
    sourceCaseName: "SYNTHETIC TITLE",
    plaintiff: "SYNTHETIC PLAINTIFF",
    defendant: "SYNTHETIC DEFENDANT",
    sourceCause: "SYNTHETIC CAUSE",
    sourceApplicationDate: "2026-08-01",
  };
  const row = {
    caseName: record.sourceCaseName,
    applicant: record.plaintiff,
    respondent: record.defendant,
    cause: record.sourceCause,
    applicationDate: record.sourceApplicationDate,
  };
  assert.deepEqual(selectSourceApiRow(record, [row]), { ok: true, row });
  for (const [field, error] of [
    ["caseName", "SOURCE_CASE_NAME_MISMATCH"],
    ["applicant", "SOURCE_APPLICANT_MISMATCH"],
    ["respondent", "SOURCE_RESPONDENT_MISMATCH"],
    ["cause", "SOURCE_CAUSE_MISMATCH"],
    ["applicationDate", "SOURCE_APPLICATION_DATE_MISMATCH"],
  ]) {
    assert.deepEqual(selectSourceApiRow(record, [{ ...row, [field]: "OTHER" }]), { ok: false, error });
  }
  assert.deepEqual(selectSourceApiRow(record, [row, { ...row }]), { ok: false, error: "SOURCE_API_ROW_AMBIGUOUS" });
});
