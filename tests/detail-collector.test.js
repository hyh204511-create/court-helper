import assert from "node:assert/strict";
import { test } from "node:test";

import { collectDetail, selectLatestAuditRecord } from "../extension/content/case-collectors.js";

function makeEl(selMap) {
  return {
    querySelector(sel) {
      const hit = selMap[sel];
      return hit === undefined ? null : hit;
    },
    querySelectorAll(sel) {
      return selMap[sel] ?? [];
    },
  };
}

function item(text) {
  return { innerText: text };
}

test("驳回详情：审核结果记录 + 审核意见（驳回原因）", () => {
  const d = collectDetail(makeEl({
    ".uni-forms-item": [
      item("审核结果\n退回补充材料"),
      item("审核时间\n2026-07-28 15:09:30"),
      item("是否调解\n否"),
      item("审核意见\n退回，补充提交一年以上且仍在居住的租房合同。"),
      item("立案法院\n北京市丰台区人民法院"),
      item("案件类型\n民事一审案件"),
      item("立案案由\n买卖合同纠纷"),
      item("标的金额(元)\n25000"),
    ],
  }));
  assert.equal(d.auditRecords.length, 1);
  assert.equal(d.auditRecords[0].status, "退回补充材料");
  assert.equal(d.auditRecords[0].time, "2026-07-28 15:09:30");
  assert.ok(d.opinion.includes("退回，补充提交"));
  assert.equal(d.fields["立案法院"], "北京市丰台区人民法院");
  assert.equal(d.fields["案件类型"], "民事一审案件");
  assert.equal(d.fields["标的金额(元)"], "25000");
});

test("已立案详情：多条审核记录，最新在前", () => {
  const d = collectDetail(makeEl({
    ".uni-forms-item": [
      item("审核结果\n已立案"),
      item("审核时间\n2026-07-22 17:13:12"),
      item("审核结果\n审查通过"),
      item("审核时间\n2026-07-21 15:32:37"),
      item("是否调解\n否"),
      item("审核意见\n决定立案"),
    ],
  }));
  assert.equal(d.auditRecords.length, 2);
  assert.equal(d.auditRecords[0].status, "已立案");
  assert.equal(d.auditRecords[0].time, "2026-07-22 17:13:12");
  assert.equal(d.auditRecords[1].status, "审查通过");
  assert.equal(d.auditRecords[1].opinion, "决定立案");
  assert.equal(d.opinion, null, "最新记录缺意见时不得回退拼接历史意见");
});

test("多条审核历史：最新时间只绑定同组最新意见", () => {
  const d = collectDetail(makeEl({
    ".uni-forms-item": [
      item("审核结果\n退回补充材料"),
      item("审核时间\n2026-08-07 09:30:00"),
      item("审核意见\n最新一次补充要求"),
      item("审核结果\n审核不通过"),
      item("审核时间\n2026-08-01 10:00:00"),
      item("审核意见\n历史意见不得导出"),
    ],
  }));
  assert.equal(d.auditRecords.length, 2);
  assert.deepEqual(d.auditRecords[0], {
    status: "退回补充材料",
    time: "2026-08-07 09:30:00",
    opinion: "最新一次补充要求",
  });
  assert.deepEqual(d.auditRecords[1], {
    status: "审核不通过",
    time: "2026-08-01 10:00:00",
    opinion: "历史意见不得导出",
  });
  assert.equal(d.opinion, "最新一次补充要求");
});

test("强执详情：字段含原审案号/执行依据类别", () => {
  const d = collectDetail(makeEl({
    ".uni-forms-item": [
      item("审核结果\n已立案"),
      item("审核时间\n2026-06-03 00:00:00"),
      item("审核意见\n决定立案"),
      item("立案法院\n北京市丰台区人民法院"),
      item("案件类型\n首次执行案件"),
      item("执行依据类别\n民商"),
      item("原审案号\n（2025）京0106民初60938号"),
    ],
  }));
  assert.equal(d.auditRecords[0].status, "已立案");
  assert.equal(d.auditRecords[0].time, "2026-06-03 00:00:00");
  assert.equal(d.fields["案件类型"], "首次执行案件");
  assert.equal(d.fields["执行依据类别"], "民商");
  assert.equal(d.fields["原审案号"], "（2025）京0106民初60938号");
});

test("详情页空/无表单项 → 空结构不报错", () => {
  assert.deepEqual(collectDetail(makeEl({ ".uni-forms-item": [] })),
    { auditRecords: [], fields: {}, opinion: null });
});

test("无审核结果时 opinion 为 null", () => {
  const d = collectDetail(makeEl({
    ".uni-forms-item": [item("案件类型\n民事案件")],
  }));
  assert.equal(d.auditRecords.length, 0);
  assert.equal(d.opinion, null);
});

test("最新审核记录按审核时间选择，不依赖 DOM 顺序", () => {
  const latest = selectLatestAuditRecord([
    { status: "审核不通过", time: "2026-08-01 10:00:00", opinion: "较早意见" },
    { status: "退回补充材料", time: "2026-08-07 09:30:00", opinion: "最新意见" },
  ]);
  assert.deepEqual(latest, {
    status: "退回补充材料",
    time: "2026-08-07 09:30:00",
    opinion: "最新意见",
  });
});

test("详情兼容 opinion 按审核时间取最新记录，不依赖 DOM 顺序", () => {
  const detail = collectDetail(makeEl({
    ".uni-forms-item": [
      item("审核结果\n审核不通过"),
      item("审核时间\n2026-08-01 10:00:00"),
      item("审核意见\n历史意见"),
      item("审核结果\n退回补充材料"),
      item("审核时间\n2026-08-07 09:30:00"),
      item("审核意见\n最新意见"),
    ],
  }));
  assert.equal(detail.opinion, "最新意见");
});

test("最新审核记录缺少意见时不回退到历史完整记录", () => {
  assert.equal(selectLatestAuditRecord([
    { status: "退回补充材料", time: "2026-08-07 09:30:00" },
    { status: "审核不通过", time: "2026-08-01 10:00:00", opinion: "历史意见" },
  ]), null);
});

test("任一审核记录缺少可比较时间时不回退到旧记录", () => {
  assert.equal(selectLatestAuditRecord([
    { status: "退回补充材料", opinion: "时间缺失，无法确认是否最新" },
    { status: "审核不通过", time: "2026-08-01 10:00:00", opinion: "历史意见" },
  ]), null);
});

test("最新审核时间并列时保持歧义，不任意选择", () => {
  assert.equal(selectLatestAuditRecord([
    { status: "退回补充材料", time: "2026-08-07 09:30:00", opinion: "意见一" },
    { status: "审核不通过", time: "2026-08-07 09:30:00", opinion: "意见二" },
    { status: "审核不通过", time: "2026-08-01 10:00:00", opinion: "历史意见" },
  ]), null);
});
