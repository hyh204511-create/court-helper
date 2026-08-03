import assert from "node:assert/strict";
import { test } from "node:test";

import { collectFields, collectListRows, findField } from "../extension/content/case-collectors.js";

/** 迷你 DOM stub：按选择器返回预设元素 */
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

function fieldEl(label, value) {
  return makeEl({
    ".fd-field-lable": { innerText: label },
    ".fd-field-value": { innerText: value },
  });
}

function rowEl({ status = "已立案", name = "测试案件", type = "民事一审案件", fields = [], space = true } = {}) {
  return makeEl({
    ".fd-header-status": { innerText: status },
    ".fd-header-ajmc": { innerText: name },
    ".fd-header-ajlx": { innerText: type },
    ".fd-field-item": fields,
    ".fd-case-space-btn": space ? { innerText: "案件空间" } : null,
  });
}

test("collectRow：解析状态/名称/类型/字段/空间按钮", () => {
  const rows = collectListRows(makeEl({
    ".fd-case-item": [
      rowEl({
        status: "待补充材料",
        name: "测试原告诉测试被告纠纷一案",
        type: "民事一审案件",
        fields: [
          fieldEl("参与人", "原告：测试原告；被告：测试被告"),
          fieldEl("案由", "买卖合同纠纷"),
          fieldEl("申请日期", "2026-07-21"),
          fieldEl("法院", "北京市丰台区人民法院"),
          fieldEl("审核意见", "退回，请补充材料。"),
        ],
      }),
    ],
  }));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.statusText, "待补充材料");
  assert.equal(r.caseName, "测试原告诉测试被告纠纷一案");
  assert.equal(r.caseType, "民事一审案件");
  assert.equal(r.fields.length, 5);
  assert.equal(r.hasSpaceBtn, true);
});

test("collectFields + findField：案号/立案日期提取（我的案件页）", () => {
  const row = rowEl({
    fields: [
      fieldEl("案号", "（2026）京0000民初00001号"),
      fieldEl("立案日期", "2026-07-22"),
      fieldEl("开庭时间", ""),
      fieldEl("生效时间", ""),
      fieldEl("法院", "北京市丰台区人民法院"),
    ],
  });
  const fields = collectFields(row);
  assert.equal(findField(fields, "案号"), "（2026）京0000民初00001号");
  assert.equal(findField(fields, "立案日期"), "2026-07-22");
  assert.equal(findField(fields, "法院"), "北京市丰台区人民法院");
  assert.equal(findField(fields, "不存在的字段"), null);
});

test("collectListRows：多行与空列表容错", () => {
  const rows = collectListRows(makeEl({
    ".fd-case-item": [rowEl({ status: "已立案" }), rowEl({ status: "已结案", type: "执行类案件", space: false })],
  }));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].statusText, "已结案");
  assert.equal(rows[1].caseType, "执行类案件");
  assert.equal(rows[1].hasSpaceBtn, false);

  assert.deepEqual(collectListRows(makeEl({ ".fd-case-item": [] })), []);
});

test("字段缺 value 时返回空字符串而非报错", () => {
  const row = rowEl({ fields: [fieldEl("开庭时间", "")] });
  const fields = collectFields(row);
  assert.equal(fields[0].value, "");
});

test("选择器失效 → 抛 SELECTOR_CHANGED（禁降级猜测）", () => {
  // 行内缺状态选择器（站点改版模拟）
  const badRow = makeEl({
    ".fd-header-ajmc": { innerText: "x" },
    ".fd-header-ajlx": { innerText: "民事案件" },
    ".fd-field-item": [],
  });
  assert.throws(
    () => collectListRows(makeEl({ ".fd-case-item": [badRow] })),
    (e) => e.code === "SELECTOR_CHANGED" && e.selectorKey === "list.status",
  );
  // 根元素无效（无 querySelectorAll）
  assert.throws(
    () => collectListRows(null),
    (e) => e.code === "SELECTOR_CHANGED",
  );
  // 空列表页合法（暂无数据）
  assert.deepEqual(collectListRows(makeEl({ ".fd-case-item": [] })), []);
});
