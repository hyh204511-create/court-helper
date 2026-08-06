# 规格：server-module（服务器核心与插件同步）

> 版本：0.1 ｜ 状态：已确认、待实现 ｜ 依据：2026-08-04 已确认服务器决策（覆盖实施计划 §6，ponytail 轻便模式）

## 1. 目标与运行形态

服务器只提供：系统认证、两类账号管理、案件结果回传、截图上传/读取、后台 REST、插件同步。

- 形态：当前维护版 Node.js LTS + TypeScript + Fastify，模块化单体；一个应用容器，不拆微服务。
- 部署：**自包含交付**——客户零基础设施即可运行。腾讯云或阿里云单实例 Docker Compose：Compose 内置 PostgreSQL 容器（数据卷持久化）+ 默认本地磁盘存储卷（截图等对象）；`app` 前置 TLS 反向代理（nginx profile）。可选升级：配置外部 PostgreSQL 连接串或云 COS/OSS（`LOCAL_STORAGE_DIR` 不设 + 填 `OBJECT_STORAGE_*` 即切换到外部存储），交付默认不依赖任何外部服务。
- API 前缀 `/api/v1`；普通响应为 JSON，截图上传为 multipart。时间戳统一存 `timestamptz`、返回 ISO 8601，业务日期为 `YYYY-MM-DD`。
- 强制在线：插件启动批次前必须通过健康检查和认证；运行中不可达则暂停、保留未确认 outbox 项并明确提示重试，不继续采集、不伪报成功、不静默切回纯本地模式。
- 实时方式：插件和后台只做 3–5 秒短轮询；页面隐藏时暂停或退避。单实例不引入 Redis、队列、SSE/长连接或分布式锁。

## 2. PostgreSQL 最小模型

所有主键为 UUID；除业务日期外的时间列均为 `timestamptz`。迁移必须使用版本化 SQL，生产启动不得自动破坏性改表。

| 表 | 最小字段与约束 |
|---|---|
| `users` | `id`，`username`（大小写归一后唯一），`password_hash`，`role` ∈ `{admin,user}`，`enabled`，`deleted_at`，`created_at`，`updated_at` |
| `sessions` | `id`，`user_id`，`token_hash`（唯一，只存摘要），`client_type` ∈ `{admin_ui,extension}`，`expires_at`，`revoked_at`，`created_at`；用户停用、删除或重置密码时全部撤销 |
| `platform_accounts` | `id`，`label`（非密唯一标签），`secret_ciphertext`，`secret_iv`，`secret_tag`，`secret_version=1`，`enabled`，`deleted_at`，`created_by`，`created_at`，`updated_at`；所有已登录后台用户可经专用 no-store 接口读取明文账号密码 |
| `import_batches` | `id`，`file_name`（净化 basename），`object_key`（私有且不经普通响应返回），`sha256`，`byte_size`，`created_by`，`created_at`，`updated_at`，`expires_at`；保存后台上传 xlsx 与受控解析结果的批次基线，所有已登录后台用户可查看完整内容/下载 |
| `cases` | `id`，`client_uid`（唯一，对应 IndexedDB `uid`），`platform_account_id`，`kind` ∈ `{li,qz}`，`plaintiff`，`defendant`，`status` ∈ `{立案成功,强执成功,已驳回,审核中,UNKNOWN}`，`filed_time`，`case_number`，`reject_time`，`reject_reason`，`query_time`，`needs_human`，`error_code`，`source_event_id`，`source_updated_at`，`revision`（全局单调递增），`created_at`，`updated_at` |
| `screenshots` | `id`，`case_id`，`type` ∈ `{success,reject,enforcement_success}`，`object_key`（唯一且不经普通 API 返回），`content_type` ∈ `{image/jpeg,image/png}`，`byte_size`，`sha256`，`captured_at`，`created_at`；`(case_id,type)` 唯一，重传相同哈希为幂等，替换时清理旧对象 |
| `report_exports` | `id`，`file_name`（净化名，仅 basename），`object_key`（唯一且不经普通 API 返回），`content_type`（固定 xlsx），`byte_size`，`sha256`，`created_by`，`created_at`，`updated_at`；`(sha256,created_by)` 唯一，同用户重传同文件幂等返回既有记录；详见 report-export-module 规格 |

- `cases.platform_account_id` 外键指向平台账号；平台账号“删除”为停用 + 软删除，已有案件不级联删除。
- `cases.revision` 每次有效新增/更新取数据库序列新值，作为轮询游标；案件不保存图片二进制。
- 不建租户、权限明细、任务队列、租约或新审计表。

## 3. REST 核心契约

除健康检查和登录外均需有效会话。后台使用 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie；插件使用 opaque Bearer token，服务端均只保存 token 摘要。

| 方法与路径 | 角色 | 契约 |
|---|---|---|
| `GET /health` | 公开 | PostgreSQL、对象存储均可用时 `200 {ok:true}`，否则 `503`；不返回版本、连接串或桶信息 |
| `POST /auth/login` | 公开 | `{username,password,clientType}`；校验 Argon2id 哈希与启用状态。后台设置 Cookie 并返回内存态 CSRF token；插件响应一次 opaque token |
| `POST /auth/logout` / `GET /auth/me` | 登录 | 撤销当前会话 / 返回 `{id,username,role}`；后台会话同时取得/刷新 CSRF token |
| `GET/POST /users` | admin | 列表 / 创建系统用户；密码只在请求中出现 |
| `GET/PATCH/DELETE /users/:id` | admin | 查看、改名/角色/启停、软删除；禁止停用/删除/降级最后一个启用的 admin |
| `POST /users/:id/reset-password` | admin | 请求体由管理员提交新密码；成功后撤销目标用户全部会话，响应不回显密码 |
| `GET /platform-accounts` | admin,user | 返回 `id,label,enabled,updatedAt`；不含明文凭据 |
| `GET /platform-accounts/:id/credential-view` | admin,user（仅 `admin_ui` Cookie 会话） | 专用后台明文查看接口，返回解密后的 `{account,password}`，`Cache-Control: private, no-store`；extension Bearer 会话拒绝 |
| `POST /platform-accounts`；`PATCH/DELETE /platform-accounts/:id` | admin | 创建、改标签/启停/替换凭据、软删除 |
| `POST /platform-accounts/:id/credential` | admin,user | **自动化专用凭据出口**：仅启用账号、有效 extension 会话可调用；返回解密后的 `{account,password}`，并设置 `Cache-Control: no-store`；后台页面不得调用 |
| `POST /import-batches` | admin,user（仅 `admin_ui` Cookie 会话） | multipart 上传 xlsx（`file`，≤ 20 MiB）；私有保存、按 excel-module 规则解析为受控批次；返回不含业务明文的批次元数据与 `{liRows,qzRows,skipped}` 校验摘要 |
| `GET /import-batches` | admin,user（仅 `admin_ui` Cookie 会话） | 所有登录后台用户可分页列出批次元数据；不返回对象键、解析行、账号或密码 |
| `GET /import-batches/:id/content` | admin,user（仅 `admin_ui` Cookie 会话） | 所有登录后台用户可下载完整上传文件；`Cache-Control: private, no-store`，不返回 object_key |
| `GET /import-batches/:id/extension-data` | extension（暂不实现） | 后续仅已领取且仍有效的对应查询命令可读取该批次执行数据；不得按任意 batch UUID 读取，不提供后台 HTML/凭据查看能力 |
| `GET /cases` / `GET /cases/:id` | admin,user | 按 `kind,status,platformAccountId,needsHuman,from,to` 过滤；游标分页，单页最多 200 条 |
| `GET /cases/:id/screenshots` | admin,user | 只返回截图元数据和内容 API 地址，不返回对象键/桶名 |
| `POST /cases/:id/screenshots` | admin,user | multipart 上传，需 `eventId,type,capturedAt,sha256,file`；单文件不超过 10 MiB，流式写私有桶 |
| `GET /screenshots/:id/content?download=0|1` | admin,user | 鉴权后由服务端从私有桶流式返回，设置 `Cache-Control: private, no-store`；私有桶不得公开读 |
| `POST /sync/cases` | admin,user | 一批最多 50 条结果幂等 upsert，返回逐项 `accepted/conflicts` 和最新 `cursor` |
| `GET /sync/changes?after=<revision>&limit=<n>` | admin,user | 返回保留期内、revision 更大的案件和截图元数据；不含图片二进制或任何凭据，`limit≤200` |
| `POST /report-exports` | admin,user | multipart 上传报表 xlsx（`sha256` + `file`，≤ 20 MiB，ZIP magic 校验），幂等按 `(sha256,created_by)`；返回元数据与 `created` |
| `GET /report-exports` / `GET /report-exports/:id` | admin,user | 列表（游标分页，admin 全部 / user 本人）与单条元数据；不返回 object_key |
| `GET /report-exports/:id/download` | admin,user | 服务端从存储流式返回 xlsx（`attachment` + 净化文件名 + `X-Content-SHA256` + `Cache-Control: private, no-store`） |
| `DELETE /report-exports/:id` | admin,user | 先删对象再删记录；admin 任意、user 仅本人 |

### 3.1 同步结果载荷

`POST /sync/cases` 请求为 `{batchId,items:[...]}`；每项固定为：

```text
eventId, clientUid, platformAccountId, kind, plaintiff, defendant,
status, filedTime, caseNumber, rejectTime, rejectReason, queryTime,
needsHuman, errorCode, sourceUpdatedAt
```

- `clientUid` 沿用 `db.js` 的唯一键语义；服务器不得重新猜测合并键。
- `batch-runner.js` 的 `filedDate` 在同步边界明确映射为 `filedTime`，IndexedDB 数字型 `updatedAt` 转为 ISO 8601 `sourceUpdatedAt`；`image` 不进 JSON，由状态映射到独立截图类型后上传。
- 只接受规格枚举；未知平台文本必须由插件上传为 `UNKNOWN + needsHuman=true`。原始异常只归一为稳定 `errorCode`，不上传可能含业务明文的错误栈。
- `kind=li` 不接受 `强执成功`，`kind=qz` 不接受 `立案成功`；状态与类型不一致按逐项校验错误拒收，服务器不自动改写。
- 同一 `clientUid`：相同 `eventId` 或相同 `sourceUpdatedAt` 且内容相同返回幂等成功；更旧版本或同时间不同内容返回逐项 `409 CONFLICT`，不得覆盖新值。
- 普通列表/同步响应永不包含系统密码、平台凭据、会话 token、对象存储密钥或签名原文。

## 4. 权限与凭据边界

| 能力 | admin | user |
|---|:---:|:---:|
| 系统用户增删改查、启停、重置密码/角色 | ✓ | — |
| 平台账号创建、修改、启停、替换凭据 | ✓ | — |
| 查看平台账号与平台密码（同源后台明文查看） | ✓ | ✓ |
| 启用的平台账号列表及插件按次取凭据 | ✓ | ✓ |
| 上传、查看和下载完整导入模板（同源后台） | ✓ | ✓ |
| 案件同步、案件/截图查看与下载 | ✓ | ✓ |
| 报表导出记录上传/查看/下载/删除（user 仅本人） | ✓ | ✓ |

- 系统密码使用 Argon2id 哈希；密码、登录请求体和 token 不写日志。
- 平台凭据明文为 UTF-8 JSON `{account,password}`，使用 AES-256-GCM 加密：每次写入随机 96-bit IV，AAD 固定为 `platform_account:<id>:v1`，密文、IV、tag 分列保存。
- 单主密钥由部署 secret `CREDENTIAL_MASTER_KEY` 注入（32 字节 base64），不进数据库、镜像、Compose 文件或仓库；缺失、长度错误或认证解密失败时拒绝启动/拒绝出密，不返回残缺明文。
- 日志只记录 request ID、路由模板、状态码、耗时和脱敏主体 ID；禁止记录请求/响应体、查询参数中的业务值、凭据、截图、驳回原因。无 SSE 通道。
- **后台明文查看例外**：根据已确认内部权限，`admin_ui` Cookie 会话的 admin、user 均可从专用 `credential-view` 与模板内容接口得到完整平台账号/密码及上传文件内容；这些响应一律 `Cache-Control: private, no-store`，不得通过 extension Bearer、普通列表、command payload、任务结果、客户端存储或日志暴露。
- TLS 以下不提供服务；CORS 仅允许后台同源与配置的扩展 Origin。登录校验 Origin，其他 Cookie 写操作校验 Origin + CSRF token；Bearer 请求不接受 Cookie 降级认证。

## 5. 30 天保留与迁移

- 应用内单实例定时器每日执行一次并在启动后补跑；截止线为服务器当前时间减 30 天。
- `query_time` 早于截止线的案件及截图必须删除；`report_exports.created_at` 早于截止线的记录同样删除；一律先删除存储后端对象（本地磁盘或 COS/OSS），成功或对象已不存在后再删元数据。失败留待下次重试并输出不含业务明文的计数告警。
- 过期/撤销 session 同步清理；系统用户和平台账号不按 30 天自动删除。同步接口拒绝写入早于截止线的案件，防止插件重新灌回过期数据。
- 首次迁移只选近 30 天：以既有 IndexedDB 为当前批本地基线，新增 `extension/data/remote-client.js`、`outbox.js`、`sync-coordinator.js` 等隔离远端逻辑；每批最多 50 条 shadow-write。
- 每条只有收到服务器 ACK 才标记远端完成；按批比对记录数、字段和截图哈希后才切换该批读取源。任一差异暂停该批并继续以本地数据为准，禁止全量一次切换。

## 6. 错误模型

请求级错误统一为：

```json
{"error":{"code":"VALIDATION_ERROR","message":"可安全展示的信息","requestId":"...","retryable":false,"details":[]}}
```

- `400 VALIDATION_ERROR`，`401 AUTH_REQUIRED`，`403 FORBIDDEN`，`404 NOT_FOUND`，`409 CONFLICT/ACCOUNT_DISABLED`，`413 PAYLOAD_TOO_LARGE`，`503 DEPENDENCY_UNAVAILABLE`。
- `details` 仅含字段名和稳定校验码；生产响应不含 SQL、栈、路径、对象键、业务明文或加密材料。
- 批同步的单项冲突放在成功响应的 `conflicts[]`；整个请求不可解析或依赖不可用才整体失败。插件对 `retryable=true` 显式提示并保留 outbox，不自动无限重试。

## 7. 验收门槛

1. 先有失败测试再实现；既有插件测试不得因新增服务器逻辑改变结果，默认未配置服务器时不加载远端模块。
2. Compose 单实例经 TLS 可启动（内置 PostgreSQL + 本地磁盘存储，开箱即用，不依赖客户任何基础设施）；依赖故障时 `/health` 返回 503，插件暂停并提示重试。
3. 认证覆盖登录/登出、禁用、重置撤销会话、最后一个 admin 保护；所有越权 API 返回 403，不能只靠页面隐藏。
4. AES-GCM 随机 IV、AAD、防篡改失败、密钥缺失启动失败均有测试；日志及普通 API 自动扫描不出现测试凭据。
5. 同一同步事件重复提交不重复写；旧版本不覆盖新版本；50 条边界、字段映射、UNKNOWN、截图幂等和轮询游标测试通过。
6. 私有桶不能匿名读，未登录不能上传/读取；user 管理系统用户或平台账号必须返回 403；授权截图经服务端流式查看和下载，响应不得暴露对象键。
7. 用脱敏数据验证 30 天边界、对象先删、失败重试、过期数据拒收；迁移只覆盖近 30 天且可按批回退本地读取。
8. 报表导出：上传幂等（同 sha256 不重复写）、越权（user 看他人/下载/删除 403）、下载流式与 SHA256 头、30 天清理均按 report-export-module 测试通过。

## 8. 范围外（不做）

- 不做多租户、组织/法院隔离、四级或自定义 RBAC、SSO/LDAP。
- 不做 KMS、信封加密、多主密钥轮换、短时凭据租约；不把主密钥写入代码或数据库。
- 不做 Redis、消息队列、后台 worker 集群、SSE/WebSocket、长连接、微服务或多实例高可用。
- 不做离线继续采集、静默本地降级、自动无限重试；outbox 只用于在线失败后的明确重试与幂等保护。
- 不做审计系统重设计、统计报表、通知中心、截图 OCR、案件人工编辑或超过 30 天的历史迁移；报表文件一律由插件本地生成后上传，服务器不生成报表内容。
