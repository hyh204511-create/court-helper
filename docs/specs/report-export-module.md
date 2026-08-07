# 规格：report-export-module（报表导出记录与再下载）

> 版本：0.2 ｜ 状态：已确认、待真实验收 ｜ 依据：Phase 11 后台控制台唯一入口决策、browser-command-module、server-module（存储/鉴权/错误模型复用）

## 1. 目标与边界

后台控制台创建 `EXPORT_REPORT` 命令后，扩展在真实法院标签页执行导出：生成并本地下载 `立案与强执查询表-<日期>.xlsx`，随后在服务器在线时**自动上传该文件**；服务器持久化记录（PostgreSQL + 对象存储），后台管理页可**再次下载**与删除。浮动面板只显示脱敏状态和进度，不提供导出按钮。

- 参考（san-ke-yi-wei）：服务端 `ExportJob` 记录 `file_name / file_sha256 / 导出人 / 创建时间`；`GET api/exports/<id>/download` 流式返回（`as_attachment` + 原文件名 + `Cache-Control: no-store` + `X-Content-SHA256` 响应头）；过期定期清理。
- 本模块完全复用 `screenshots` 模块的既有模式：对象存储（本地磁盘 / COS/OSS）、鉴权（Bearer / Cookie）、错误信封、30 天保留。
- **上传失败不阻塞**：本地下载先行，上传为尽力而为（best-effort），失败仅提示，不重试队列、不伪装成功。
- 报表文件 = 业务数据（含当事人等），存储与截图同等级保护：对象键不出普通 API、日志不含业务明文、私有桶不可匿名读。

## 2. 数据模型（PostgreSQL，迁移 004）

```sql
CREATE TABLE IF NOT EXISTS report_exports (
  id UUID PRIMARY KEY,
  file_name TEXT NOT NULL,              -- 净化后的文件名（仅 basename，含 .xlsx 后缀）
  object_key TEXT NOT NULL UNIQUE,      -- 存储对象键，任何 API 不返回
  content_type TEXT NOT NULL,           -- 固定 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  byte_size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,                 -- 小写 hex 64
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS report_exports_created_by_idx ON report_exports (created_by, created_at);
CREATE INDEX IF NOT EXISTS report_exports_created_at_idx ON report_exports (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS report_exports_sha256_creator_uidx
  ON report_exports (sha256, created_by);
```

- 幂等键：`(sha256, created_by)` 唯一；同一用户重复上传同一文件 → 返回既有记录（`created:false`），不重复写对象。
- 不建任务队列、不建导出模板/快照表（插件本地生成文件，服务器只存结果）。

## 3. REST 契约（前缀 `/api/v1`，均需有效会话）

| 方法与路径 | 角色 | 契约 |
|---|---|---|
| `POST /api/v1/report-exports` | admin,user | multipart：`sha256`（必填 hex64）与 `file`（必填，xlsx）。校验：xlsx magic（ZIP `PK\x03\x04`）与声明 Content-Type 一致；单文件 ≤ 20 MiB。成功 `201 {id,fileName,byteSize,sha256,createdAt,created}`；幂等命中返回既有记录 `200`（`created:false`） |
| `GET /api/v1/report-exports` | admin,user | 游标分页（与 cases 一致，`limit≤200`，按 `created_at DESC`）；**admin 返回全部，user 只返回本人**；响应仅元数据（`id,fileName,byteSize,sha256,createdAt,createdBy`），无 object_key |
| `GET /api/v1/report-exports/:id` | admin,user | 单条元数据；越权 404（不暴露存在性） |
| `GET /api/v1/report-exports/:id/download` | admin,user | 服务端从存储流式返回；`Content-Disposition: attachment; filename*=UTF-8''<净化名>`；`Content-Type` 固定 spreadsheetml；`Cache-Control: private, no-store`；`X-Content-SHA256: <sha256>`；`Content-Length: byte_size`；越权 403 |
| `DELETE /api/v1/report-exports/:id` | admin,user | 先删对象（成功或已不存在均继续删记录）再删记录；admin 任意、user 仅本人；越权 403 |

- 上传校验失败 → `400 VALIDATION_ERROR`（`sha256_required` / `sha256_invalid` / `file_required` / `magic_not_allowed` / `mime_mismatch`）；超限 → `413 PAYLOAD_TOO_LARGE`。
- 请求幂等性只由 `(sha256, created_by)` 定义；不接受、存储或透传无独立服务端语义的 `clientExportId`，也不以 `Idempotency-Key` 改变该规则。
- 文件名净化：仅取 basename；剥离控制字符；长度 ≤ 200；保留 CJK、字母数字、`- _ . （）`；空/异常 → 服务端生成 `report-<日期>.xlsx`。服务端存储/下载均用净化名。
- 错误模型、请求 ID、脱敏日志规则同 server-module §6（日志只记 ID/路由/状态码/耗时，不记文件名外的业务值；文件名仅含日期，允许记）。
- **ID/UUID 校验**：路径 `:id` 与游标 `cursor.id` 必须在路由边界校验为 UUID 格式，非法值返回稳定的 `400/404`（禁止落库后由数据库 cast 报错）。

## 4. 权限矩阵

| 能力 | admin | user |
|---|:---:|:---:|
| 上传（extension 会话或后台会话） | ✓ | ✓ |
| 列表/详情/下载 | 全部 | 仅本人 |
| 删除 | 全部 | 仅本人 |

## 5. 保留（30 天）

- 扩展 `retention/service.ts`：按 `created_at` 早于截止线删除 `report_exports`；先删对象（成功或已不存在）再删记录；结果计数并入 `RetentionCleanupResult`（`deletedReportExports`）。
- 与案件/截图同一调度器每日执行 + 启动补跑；失败留待下次，日志仅计数。

## 6. 扩展命令执行链

### 6.1 导出后上传（核心流程不变，只做加法）

```
后台控制台创建 EXPORT_REPORT → SW 领取命令 → content 执行器
        → buildExportWorkbook → 本地下载（既有逻辑原样）
        → 计算 sha256（crypto.subtle，hex64）
        → 二进制转 base64，chrome.runtime.sendMessage({type:"EXPORT_UPLOAD", fileName, sha256, base64, mime})
        → SW 解码 base64 → Blob → remote client POST /report-exports
        → 回执：成功 → 提示「已上传服务器，后台可再次下载」
                 NOT_CONFIGURED → 提示「未配置服务器，仅本地保存」
                 失败 → 提示「上传失败，本地文件已保存」（不重试、不阻塞）
```

- `EXPORT_UPLOAD` 由 **service-worker** 处理（设备 token 只在 SW 使用，content 不接触该 token）；SW 在 `initializeSyncCoordinator` 时持有 remote client 引用；未配置服务器 → `{ok:false, code:"NOT_CONFIGURED"}`。
- 统一命令回写必须保留上传结果：`uploaded` → `succeeded/SUCCESS`；`not_configured` → `manual_required/NOT_CONFIGURED`；`failed` → `manual_required/<稳定上传错误码>`。后两者的安全摘要明确“本地文件已保存”，不得伪装成 `SUCCESS`，也不得触发自动重试。
- **二进制交接用 base64**：Chromium 扩展消息为 JSON 序列化（官方 messaging 文档），Blob/ArrayBuffer 不保真；content 执行器把 xlsx 字节转 base64 字符串随消息发送，SW 侧 `atob` 解码为 Uint8Array 再构造 Blob 上传。base64 膨胀约 33%，单文件受服务器 20 MiB 上限约束（超出由服务器 413 拒绝）。测试必须模拟浏览器 JSON 序列化往返（`JSON.parse(JSON.stringify(message))`）。
- 导出执行保持 single-flight；同一法院标签页不得并发生成两份报表。状态和安全摘要通过统一 browser command 回写，浮动面板只作状态提示。
- **SW 配置懒初始化**：`EXPORT_UPLOAD` 到达时若 SW 尚无 remote client，须重新读取 `chrome.storage.local` 同步配置并初始化（运行中新增/清除服务器配置立即生效）；相关 storage 键变化时重建 client，不得沿用过期配置。

### 6.2 列表页门禁

- content 执行器仅在网上立案列表 `#/pagesWsla/pc/list/index` 或我的案件列表 `#/pages/pc/case-list/index` 执行查询/导出命令；登录页、详情页和其他相似 hash 路由一律以稳定错误 `PAGE_NOT_LIST` 拒绝，且不得下载或上传。
- 页面门禁由 content 与统一 browser command 执行器负责，不再存在独立界面路由门禁模块。

### 6.3 强执批量入口（挂真实平台）

- 后台控制台以 `QUERY_LI` / `QUERY_QZ` 区分查询类型；SW 下发给 content 的 `START_BATCH` 消息载荷带 `kind`（`li`/`qz`）。
- content `startBatch(kind)` 既有实现已按 kind 选 store（`cases`/`enforcementCases`），不改调度核心。
- **不自动切 tab**：强执批量要求用户当前停在「执行」tab（采集器按行内 caseType 识别状态，不改写动作）。**启动门禁**：`START_BATCH(kind=qz)` 时若当前页面可见行中不存在执行类 caseType（含「执行」）的行 → 返回稳定错误 `EXECUTION_TAB_REQUIRED`，控制台任务状态与浮动面板提示人工切换，禁止继续执行（防止在民事 tab 下把强执记录写成错误状态）。

## 7. 后台管理（admin-ui 增量）

- 新增页面 `/admin/report-exports`（admin,user 均可访问）：
  - 表格列：文件名、大小（KB 格式化）、SHA256（前 8 位）、导出人（**脱敏用户名**，如 `a***3`，完整用户名不得进入表格 DOM；user 角色只见本人不显示列或显示「本人」）、导出时间、操作（下载 / 删除）。
  - 下载：鉴权后走 `GET /api/v1/report-exports/:id/download`（fetch blob 保存或新标签打开，`?` 不带签名参数）；删除需二次确认，成功后重拉列表。
  - 导航：admin 与 user 均显示「报表导出」入口（user 导航当前只有案件台账，追加一项）。
- 页面不渲染 object_key、不缓存下载 URL；CSP/脱敏规则同 admin-ui-module §4。

## 8. 测试（TDD 闸门）

- **server/tests/server-report-exports.test.js**：
  - 上传成功 201（元数据断言、文件落存储、sha256 一致）；同 sha256 幂等 200 `created:false`（对象不重复写）；
  - 校验：缺 sha256 / 非法 sha256 / 缺 file / 非 ZIP magic / 声明与 magic 不符 / 超 20 MiB 413；
  - 鉴权：未登录 401；user 上传后列表只见本人；user 访问他人记录列表/详情/下载/删除 403/404；
  - 下载：流式内容一致、`Content-Disposition` 净化文件名、`X-Content-SHA256`、`no-store`；
  - 删除：对象先删、记录删除；重复删除 404；
  - 保留：`created_at` 早于截止线被清理（对象与记录），晚于截止线保留。
- **extension 测试**：
- `remote-client.test.js` 增补：`uploadReportExport` 仅构造 `sha256` 与文件的 FormData、错误映射；
  - `EXPORT_UPLOAD` 消息测试须经 JSON 序列化往返（模拟浏览器丢 Blob 类型）；覆盖：base64 解码正确、未配置后置写入配置再上传成功（懒初始化）、统一命令下发所选 kind、qz 门禁 `EXECUTION_TAB_REQUIRED`；
  - service-worker：`EXPORT_UPLOAD` 未配置 → `NOT_CONFIGURED`；已配置 → 调 client 并回执（mock fetch + fake 配置）；
  - content 路由门禁对两个真实列表路由放行，对登录/详情路由拒绝；
  - browser command/content：导出上传流程（mock chrome.runtime.sendMessage）——本地下载先行、上传成功/失败/未配置三种回执文案及其命令回写；强执命令发送 `kind:"qz"`。
- 既有测试不得因本次改动改变结果。

## 9. 验收门槛（真实验收）

1. 本机 PostgreSQL + 服务器：插件导出 → 后台「报表导出」出现记录 → 下载文件与本地导出一致（sha256 对比）→ 删除后消失。
2. 真实平台（用户已登录会话）：控制台在网上立案列表页与“我的案件”页创建的查询命令均可执行；执行 tab 下“强执”批量可跑通 2–3 条；导出后后台有记录并可再下载。验收记录只写脱敏摘要。

## 10. 范围外（不做）

- 不做服务器端生成报表/模板渲染/数据透视（文件始终由插件本地生成）。
- 不做导出队列、失败重试、离线 outbox 队列（尽力而为，用户可重按导出）。
- 不做多文件打包下载、批量删除、按内容搜索。
- 不做报表版本/审核流/共享链接；不做截图之外的附件类型。
