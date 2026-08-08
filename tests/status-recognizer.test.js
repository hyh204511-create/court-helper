import assert from "node:assert/strict";
import { test } from "node:test";

import { recognizeStatus, reconcileStatusText } from "../extension/content/status-recognizer.js";

// —— 网上立案页（pagesWsla/pc/list，状态字典 11800007）——
test("网上立案页：待审核 → 审核中", () => {
  assert.equal(recognizeStatus({ statusText: "待审核", caseType: "民事一审案件", pageKind: "wsla" }), "审核中");
});

test("网上立案页：已立案 + 民事 → 立案成功", () => {
  assert.equal(recognizeStatus({ statusText: "已立案", caseType: "民事一审案件", pageKind: "wsla" }), "立案成功");
});

test("网上立案页：审核通过按审判/执行类型映射成功状态", () => {
  assert.equal(recognizeStatus({ statusText: "审核通过", caseType: "民事一审案件", pageKind: "wsla" }), "立案成功");
  assert.equal(recognizeStatus({ statusText: "审核通过 ", caseType: "民事一审案件", pageKind: "wsla" }), "立案成功");
  assert.equal(recognizeStatus({ statusText: "已审核通过", caseType: "民事一审案件", pageKind: "wsla" }), "UNKNOWN");
  assert.equal(recognizeStatus({ statusText: "审核通过", caseType: "首次执行案件", pageKind: "wsla" }), "强执成功");
  assert.equal(recognizeStatus({ statusText: "审核通过", caseType: "执行类案件", pageKind: "wsla" }), "强执成功");
});

test("网上立案页：已立案 + 执行类 → 强执成功", () => {
  assert.equal(recognizeStatus({ statusText: "已立案", caseType: "首次执行案件", pageKind: "wsla" }), "强执成功");
  assert.equal(recognizeStatus({ statusText: "已立案", caseType: "执行类案件", pageKind: "wsla" }), "强执成功");
});

test("网上立案页：驳回类文本 → 已驳回", () => {
  for (const t of ["待补充材料", "审核不通过", "不予立案", "待补正"]) {
    assert.equal(recognizeStatus({ statusText: t, caseType: "民事一审案件", pageKind: "wsla" }), "已驳回", t);
  }
});

test("网上立案页：未知文本 → UNKNOWN（禁猜）", () => {
  for (const t of ["待提交", "申请失效", "撤回中", "提交失败", "乱七八糟", ""]) {
    assert.equal(recognizeStatus({ statusText: t, caseType: "民事一审案件", pageKind: "wsla" }), "UNKNOWN", t);
  }
});

// —— 我的案件页（pages/pc/case-list）——
test("我的案件页：审理中 + 民事 → 立案成功（案号存在=已成功立案）", () => {
  assert.equal(recognizeStatus({ statusText: "审理中", caseType: "民事案件", pageKind: "mycase" }), "立案成功");
});

test("我的案件页：已结案 + 执行类 → 强执成功", () => {
  assert.equal(recognizeStatus({ statusText: "已结案", caseType: "执行类案件", pageKind: "mycase" }), "强执成功");
});

test("我的案件页：已结案 + 民事 → 立案成功", () => {
  assert.equal(recognizeStatus({ statusText: "已结案", caseType: "民事案件", pageKind: "mycase" }), "立案成功");
});

test("我的案件页：未知文本 → UNKNOWN", () => {
  assert.equal(recognizeStatus({ statusText: "调解中", caseType: "民事案件", pageKind: "mycase" }), "UNKNOWN");
  assert.equal(recognizeStatus({ statusText: "", caseType: "民事案件", pageKind: "mycase" }), "UNKNOWN");
});

// —— 兜底：未识别页面类型也按文本映射（同文案规则）——
test("兜底：pageKind 缺失时按文本规则处理", () => {
  assert.equal(recognizeStatus({ statusText: "待审核" }), "审核中");
  assert.equal(recognizeStatus({ statusText: "已立案", caseType: "民事一审案件" }), "立案成功");
  assert.equal(recognizeStatus({ statusText: "已立案", caseType: "首次执行案件" }), "强执成功");
  assert.equal(recognizeStatus({ statusText: "未知状态" }), "UNKNOWN");
});

test("强执状态证据：DOM 空文字使用 layy 精确状态，已识别冲突则拒绝", () => {
  assert.equal(reconcileStatusText({
    domStatusText: "",
    sourceStatusText: "审核不通过",
    caseType: "首次执行案件",
    pageKind: "wsla",
  }), "审核不通过");
  assert.throws(() => reconcileStatusText({
    domStatusText: "审核通过",
    sourceStatusText: "审核不通过",
    caseType: "首次执行案件",
    pageKind: "wsla",
  }), (error) => error?.message === "UNKNOWN_STATUS_CONFLICT");
});
