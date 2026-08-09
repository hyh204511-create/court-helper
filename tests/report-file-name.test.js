import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeReportFileName } from "../extension/data/report-file-name.js";

test("报表使用净化后的平台账号标签命名", () => {
  assert.equal(sanitizeReportFileName(" 账号标签（甲） "), "账号标签（甲）.xlsx");
  assert.equal(sanitizeReportFileName("../账号<标签>.xlsx"), "账号标签.xlsx");
  assert.equal(sanitizeReportFileName("<>/", new Date("2026-08-09T00:00:00Z")), "report-2026-08-09.xlsx");
});
