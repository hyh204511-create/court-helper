# 规格：excel-module（模板、导入、导出、数据模型）

> 版本：0.2 ｜ 状态：已实现、入口迁移待验收 ｜ 依据：脱敏测试模板解析、Phase 11 控制台唯一入口决策

## 1. 模板事实（唯一权威，来自真实模板解析）

- 单工作表 `Sheet1`，两个表块，共 12 列（A–L）：

| 列 | 立案表头（第 1 行） | 强执表头（动态行） |
|---|---|---|
| A | 原告 | 原告 |
| B | 被告 | 被告 |
| C | 账号 | 账号 |
| D | 密码 | 密码 |
| E | 立案状态 | 强执状态 |
| F | 立案成功时间 | 强执成功时间 |
| G | 案号 | 强执案号 |
| H | 成功图片 | 成功图片 |
| I | 驳回时间 | 驳回时间 |
| J | 驳回原因 | 驳回原因 |
| K | 驳回图片 | 驳回图片 |
| L | 查询时间 | 查询时间 |

- 模板示例：立案表头第 1 行、数据第 2–4 行；强执表头第 9 行、数据第 10–12 行；两表块之间空 4 行。
- **导出布局（已确认默认）**：立案表头固定第 1 行；强执表头 = 立案末行 + 5（立案 3 条 → 第 8 行 +1 = 9？否：立案末行 4 → +5 = 9，与模板一致）。
- 状态词枚举：立案 `{立案成功, 已驳回, 审核中}`；强执 `{强执成功, 已驳回, 审核中}`；插件内部另有 `UNKNOWN`（不写入导出文件，导出时该行状态留空并标红提示）。
- 图片单元格：模板中为 `=_xlfn.DISPIMG("ID_xxx",1)`（WPS 公式）。**插件导出用 ExcelJS 标准嵌入图片（OneCellAnchor 锚定目标单元格）**，WPS/Excel 均可显示；导出文件不生成 DISPIMG 公式。
- 样式（导出必须复刻）：
  - 表头：加粗 11 号、填充 `FF92D050`、行高 27；
  - 数据行：行高 28；
  - 列宽：A 15 / B 14 / C 20.37 / D 15.5 / E 默认 / F 13.25 / G 24.13 / H 12.87 / I 默认 / J 39.63 / K 18 / L 10.75；
  - 日期列（F 成功时间、I 驳回时间、L 查询时间）数字格式 `mm-dd-yy`，值为日期型。

## 2. 数据模型（IndexedDB）

### store `cases`（立案）
| 字段 | 类型 | 来源 |
|---|---|---|
| id | auto | — |
| account | string | C 列 |
| password | string | D 列（只读透传，不参与登录、不导出修改、不显示明文） |
| plaintiff | string | A 列 |
| defendant | string | B 列 |
| status | enum | 立案成功/已驳回/审核中/UNKNOWN |
| filedTime | string|null | F 列（YYYY-MM-DD） |
| caseNumber | string|null | G 列 |
| successImage | blob|null | H 列（截图） |
| rejectTime | string|null | I 列 |
| rejectReason | string|null | J 列 |
| rejectImage | blob|null | K 列 |
| queryTime | string | L 列（YYYY-MM-DD，查询当天） |
| updatedAt | number | 自动 |

### store `enforcementCases`（强执）
同 `cases`，字段语义替换：status ∈ `{强执成功, 已驳回, 审核中, UNKNOWN}`；filedTime=强执成功时间；caseNumber=强执案号；successImage=强执成功图片。

### store `screenshots`
`{ id, caseId, type: 'success'|'reject'|'enforcement_success', data: blob, takenAt }`（或直接内嵌于 cases 记录，实现时二选一，规格默认**内嵌于案件记录**，图片压缩 JPEG 0.85）。

### 唯一键（已确认默认）
`账号 + 案号`；案号为空时退化为 `账号 + 原告 + 被告`。导入与写库时：已存在 → 更新（状态/时间/图片覆盖）；不存在 → 追加。

## 3. 导入规则（Excel → IndexedDB）

1. 读取 xlsx（ExcelJS），取 `Sheet1`。
2. 表头校验：第 1 行 12 列与模板完全一致（逐列文本比对）→ 不一致报错「模板不匹配：<列名>」，中止导入。
3. 块解析：立案块 = 第 2 行起，到强执表头行前；强执表头行 = 首个「A=原告 且 E=强执状态」的行（按内容识别，不依赖固定行号）；强执块 = 其后到末尾。
4. 行校验：A/C 必填（原告、账号），缺失 → 该行跳过并计入「跳过 N 条（缺必填）」。
5. **DISPIMG 单元格跳过**：H/K 列的 `=_xlfn.DISPIMG(...)` 公式不解析、不读图——图片由插件查询后重新截图生成。
6. 唯一键去重：按 §2 唯一键，已存在 → 更新导入字段（不覆盖已有截图/时间，除非本次导入提供新值——默认：导入仅更新基础字段，查询结果才覆盖业务字段）。
7. 返回摘要 `{ imported, updated, skipped, reasons[] }`；后台控制台展示服务器受控批次摘要，扩展不再通过 Popup 展示。

## 4. 导出规则（IndexedDB → Excel）

1. 用 ExcelJS 新建工作簿，Sheet1，按 §1 样式复刻（表头行、行高、列宽、日期格式）。
2. 布局：立案表头第 1 行，立案数据行随后（按导入顺序或查询时间排序，默认导入顺序）；强执表头 = 立案末行 + 5，强执数据行随后。
3. 单元格写入：
   - 状态列：状态词原样；UNKNOWN → 留空 + 该行状态单元格填充浅红（`FFFFC7CE`）+ 字体深红（`9C0006`）提示待人工；
   - 日期列：JS Date 写入 + numberFormat `mm-dd-yy`；
   - 密码列：原样透传（只读字段，不脱敏导出——用户表格业务需要；但导出日志不打印）。
4. 图片嵌入：有 successImage → `ws.addImage(data, { tl: {col: H-1, row}, ext: {width, height} })`，OneCellAnchor 锚定 H/K 列对应单元格；尺寸：高度 = 行高 28 像素内（约 34px），宽度按 H 12.87 / K 18 列宽比例（约 60 / 90 px），实现时以模板图片观感为准微调。
5. 文件命名：`立案与强执查询表-<导出日期YYYY-MM-DD>.xlsx`；`EXPORT_REPORT` 命令由扩展生成并本地下载，随后上传服务器形成后台报表记录。

## 5. 往返一致性（测试闸门）

`导入 fixture → 写库 → 填业务字段（含图片）→ 导出 → 读回对比`：
- 表头 12 列一致；立案/强执块行号与预期一致；
- 各字段值一致（日期按 mm-dd-yy 字符串比对）；
- 图片：导出文件内嵌图片数量 = 写库有图记录数，锚点位于对应单元格区域；
- 用 Python openpyxl 二次读回交叉验证（脚本 `scripts/verify-export.py`）。

## 6. 脱敏 fixture

- 真实模板（含真实业务数据）只存本地私有位置（`.hermes/desktop-attachments/`），**不进 git**。
- 测试用 `tests/fixtures/立案与强执查询表-脱敏模板.xlsx`：由 `scripts/generate-fixtures.py`（openpyxl）生成，保留 §1 全部表头/样式/布局，示例行用模拟数据（原告「测试原告甲」、账号 `TEST-ACCOUNT-001`、案号 `（2026）京0000民初00000号` 等），含一条 DISPIMG 公式单元格（用于导入跳过逻辑测试）。
- `scripts/verify-fixture.py` 校验 fixture 结构（表头/样式/块行号），CI/提交前运行。

## 7. 范围外（不做）

- 不解析/生成 DISPIMG 公式；不做 WPS 专有图片格式。
- 不支持多工作簿/多 Sheet 模板；不修改模板本身（导出为新建文件）。
- 不读取模板内已有嵌入图片。
- 不做数据透视/统计/图表；不做 Excel 宏。
- 真实业务 xlsx（用户导出结果）不提交 git（`*.xlsx` ignore，fixture 除外）。
