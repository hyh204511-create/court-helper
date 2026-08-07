import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlatformDiscoveryRecords,
  parseParticipantField,
  selectDiscoveredListRow,
} from "../extension/data/platform-discovery.js";

test("平台发现：只接受参与人字段的精确原告/被告结构，不从案件标题猜测", () => {
  assert.deepEqual(
    parseParticipantField("原告：平台原告；被告：平台被告"),
    { plaintiff: "平台原告", defendant: "平台被告" },
  );
  assert.deepEqual(
    parseParticipantField("申请执行人：平台申请人；被执行人：平台被执行人", "qz"),
    { plaintiff: "平台申请人", defendant: "平台被执行人" },
  );
  assert.throws(
    () => parseParticipantField("平台原告诉平台被告买卖合同纠纷一案"),
    (error) => error?.code === "PARTY_FIELDS_UNAVAILABLE",
  );
});

test("平台发现：从真实列表建立当前账号记录、同当事人案由只保留最新申请日", () => {
  const records = buildPlatformDiscoveryRecords({
    account: "PLATFORM-ACCOUNT-001",
    platformAccountId: "00000000-0000-4000-8000-000000000001",
    kind: "li",
    rows: [
      {
        caseName: "旧案件标题",
        caseType: "民事一审案件",
        statusText: "待审核",
        fields: [
          { label: "参与人", value: "原告：平台原告；被告：平台被告" },
          { label: "案由", value: "买卖合同纠纷" },
          { label: "申请日期", value: "2026-07-01" },
        ],
      },
      {
        caseName: "新案件标题",
        caseType: "民事一审案件",
        statusText: "已立案",
        fields: [
          { label: "参与人", value: "原告：平台原告；被告：平台被告" },
          { label: "案由", value: "买卖合同纠纷" },
          { label: "申请日期", value: "2026-07-02" },
        ],
      },
    ],
  });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    account: "PLATFORM-ACCOUNT-001",
    platformAccountId: "00000000-0000-4000-8000-000000000001",
    plaintiff: "平台原告",
    defendant: "平台被告",
    sourceCaseName: "新案件标题",
    sourceCause: "买卖合同纠纷",
    sourceApplicationDate: "2026-07-02",
    status: "UNKNOWN",
    filedTime: null,
    caseNumber: null,
    rejectTime: null,
    rejectReason: null,
    queryTime: null,
  });
});

test("平台发现状态采集：同标题历史记录按原被告、案由和已选申请日期精确回绑最新一条", () => {
  const rows = [
    {
      caseName: "相同案件标题",
      fields: [
        { label: "参与人", value: "原告：平台原告；被告：平台被告" },
        { label: "案由", value: "买卖合同纠纷" },
        { label: "申请日期", value: "2026-07-01" },
      ],
    },
    {
      caseName: "相同案件标题",
      fields: [
        { label: "参与人", value: "原告：平台原告；被告：平台被告" },
        { label: "案由", value: "买卖合同纠纷" },
        { label: "申请日期", value: "2026-07-02" },
      ],
    },
  ];
  const [record] = buildPlatformDiscoveryRecords({ account: "PLATFORM-ACCOUNT-001", kind: "li", rows });

  assert.deepEqual(selectDiscoveredListRow({ record, kind: "li", rows }), { ok: true, index: 1 });
  assert.deepEqual(
    selectDiscoveredListRow({ record: { ...record, sourceApplicationDate: null }, kind: "li", rows }),
    { ok: false, error: "CASE_MATCH_AMBIGUOUS" },
  );
});

test("平台发现：超过单批上限或无法精确读取参与人时，拒绝写入任何记录", () => {
  const valid = {
    caseName: "案件标题",
    fields: [{ label: "参与人", value: "原告：平台原告；被告：平台被告" }],
  };
  assert.throws(
    () => buildPlatformDiscoveryRecords({ account: "A", kind: "li", rows: Array.from({ length: 51 }, () => valid) }),
    (error) => error?.code === "BATCH_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => buildPlatformDiscoveryRecords({ account: "A", kind: "li", rows: [{ caseName: "仅标题", fields: [] }] }),
    (error) => error?.code === "PARTY_FIELDS_UNAVAILABLE",
  );
});
