// simulator 端到端验收：jsdom 加载模拟页 → 真实采集器逻辑断言
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import {
  collectListRows,
  extractBusinessFields,
  findField,
  collectDetail,
} from "../extension/content/case-collectors.js";
import { recognizeStatus } from "../extension/content/status-recognizer.js";
import { detectLoginState, getCurrentAccount } from "../extension/content/login-detector.js";

function load(htmlFile) {
  const html = readFileSync(new URL(`../simulator/${htmlFile}`, import.meta.url), "utf-8");
  return new JSDOM(html, { url: `https://zxfw.court.gov.cn/zxfw/#/${htmlFile}` });
}

test("模拟-网上立案列表：驳回案件采集（状态/审核意见/用户区）", () => {
  const dom = load("wsla-list.html");
  const doc = dom.window.document;
  assert.equal(detectLoginState({ hash: dom.window.location.hash, root: doc }), "logged-in");
  assert.equal(getCurrentAccount(doc), "测试原告");

  const rows = collectListRows(doc);
  assert.equal(rows.length, 2);
  const r0 = rows[0];
  assert.equal(r0.statusText, "待补充材料");
  assert.equal(r0.caseType, "民事一审案件");
  const opinion = findField(r0.fields, "审核意见");
  assert.ok(opinion.includes("退回"));
  // 状态识别：待补充材料 → 已驳回
  assert.equal(recognizeStatus({ statusText: r0.statusText, caseType: r0.caseType, pageKind: "wsla" }), "已驳回");
  // 已立案行 → 立案成功
  const r1 = rows[1];
  assert.equal(recognizeStatus({ statusText: r1.statusText, caseType: r1.caseType, pageKind: "wsla" }), "立案成功");
});

test("模拟-我的案件列表：成功取证（案号/立案日期）与强执识别", () => {
  const dom = load("mycase-list.html");
  const doc = dom.window.document;
  const rows = collectListRows(doc);
  assert.equal(rows.length, 2);

  const li = extractBusinessFields(rows[0].fields);
  assert.equal(li.caseNumber, "（2026）京0106民初00001号");
  assert.equal(li.filedDate, "2026-07-22");
  assert.equal(recognizeStatus({ statusText: rows[0].statusText, caseType: rows[0].caseType, pageKind: "mycase" }), "立案成功");

  const qz = extractBusinessFields(rows[1].fields);
  assert.equal(qz.caseNumber, "（2026）京0106执00001号");
  assert.equal(qz.filedDate, "2026-06-03");
  assert.equal(recognizeStatus({ statusText: rows[1].statusText, caseType: rows[1].caseType, pageKind: "mycase" }), "强执成功");
});

test("模拟-详情页：驳回取证（审核时间/驳回原因）", () => {
  const dom = load("detail.html");
  const doc = dom.window.document;
  const detail = collectDetail(doc);
  assert.equal(detail.auditRecords.length, 1);
  assert.equal(detail.auditRecords[0].status, "退回补充材料");
  assert.equal(detail.auditRecords[0].time, "2026-07-28 15:09:30");
  assert.ok(detail.opinion.includes("退回"));
  assert.equal(detail.fields["立案法院"], "北京市丰台区人民法院");
  assert.equal(detail.fields["标的金额(元)"], "25000");
});
