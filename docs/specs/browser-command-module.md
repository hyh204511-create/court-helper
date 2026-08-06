# 规格：browser-command-module（后台唯一业务入口与扩展执行代理）

> 版本：0.1 ｜ 状态：已确认、待实现 ｜ 依据：用户明确要求“popup 全部功能转到后台并移除”；现有 login-command-bridge、server-module、app-module、panel-module、report-export-module

## 1. 目标与最终职责

本模块把法院抓取业务入口统一到同源后台管理页，移除 popup 业务界面。后台只负责创建任务、展示状态和下载结果；浏览器扩展只负责在用户已打开的真实法院标签页执行页面动作。

```text
后台管理页（唯一业务入口）
→ browser_commands 指令
→ 扩展 Service Worker 轮询/领取
→ 真实法院标签页 content script 执行
→ 扩展回写稳定结果
→ 后台展示进度/结果
```

- popup 不再作为业务入口；最终从 manifest 移除 `action.default_popup`，popup 文件及专用调用链删除或迁移后归档。
- 法院页面浮动面板仅保留实时状态、进度和人工接管提示，不保留第二套完整导入/查询/导出业务入口。
- 后台不能直接调用法院登录 API，不能直接读取法院 DOM；所有平台动作必须由扩展在真实标签页完成。

## 2. 业务指令模型

新增 PostgreSQL 表 `browser_commands`（迁移 005）：

| 字段 | 约束/含义 |
|---|---|
| `id` | UUID 主键 |
| `type` | `LOGIN` / `QUERY_LI` / `QUERY_QZ` / `EXPORT_REPORT` |
| `status` | `pending` / `executing` / `succeeded` / `failed` / `expired` / `manual_required` / `cancelled` |
| `platform_account_id` | 可空 FK `platform_accounts(id)`；查询/登录任务引用目标平台账号 |
| `client_batch_id` | 可空，扩展本地批次/模板基线的稳定标识 |
| `requested_by` | FK `users(id)` |
| `claimed_by` | 扩展 device id，非空时只允许该设备回写 |
| `claim_token_hash` | 只存摘要，不存明文领取令牌 |
| `payload` | JSON；仅允许任务类型所需的非敏感参数，不得含密码、验证码、完整案号、当事人明文或截图 |
| `result_code` | 稳定枚举，如 `SUCCESS`、`NO_COURT_TAB`、`SESSION_EXPIRED`、`EXECUTION_TAB_REQUIRED`、`SELECTOR_CHANGED`、`NEEDS_HUMAN` |
| `result_summary` | 可安全展示的短摘要，不含平台响应正文或业务明文 |
| `created_at/updated_at/expires_at` | `timestamptz` |

- 同一平台账号同时最多一个 `pending`/`executing` 活动任务；重复创建返回 `409 DUPLICATE_PENDING`。
- 领取与回写必须幂等；错误 claimant 回写返回 `403 FORBIDDEN`，已完成任务重复回写返回原终态。
- 旧 `login_commands` 在迁移期间保留兼容；本模块不直接删除旧表。

## 3. 指令类型契约

### `LOGIN`

- 后台只提交 `platformAccountId`。
- 扩展领取后：检查法院登录页标签 → 取平台凭据 → content 执行既有 `AUTO_LOGIN` → OCR/可信点击链路不变 → 回写成功或稳定失败码。
- 密码只在服务器凭据出口到扩展运行时内存链路流转，不进入 command payload、storage、日志或后台 HTML。

### `QUERY_LI` / `QUERY_QZ`

- 后台选择查询类型、目标平台账号和**已存在、未过期的 `importBatchId`**。服务端创建命令时将该 UUID 写入 `clientBatchId`；不得接受客户端自由字符串作为查询批次引用。
- 批次绑定在命令创建时由服务器校验；后续 extension 读取批次执行数据时必须同时校验：命令处于 `executing`、`claimed_by` 与 claim token 匹配、命令的 `clientBatchId` 与请求批次一致且批次未过期。
- `QUERY_LI` 允许网上立案列表与我的案件列表。
- `QUERY_QZ` 当前页面可见行不存在执行类 `caseType` 时，必须回写 `EXECUTION_TAB_REQUIRED`，不得继续执行、不得自动切 tab。
- 扩展继续复用既有 `START_BATCH`、`runBatch`、状态识别、截图、节流（3–8 秒/案、单批 50、重试 1）。
- 查询结果经既有 sync/outbox 上传；未知状态保持 `UNKNOWN + needsHuman=true`。

### `EXPORT_REPORT`

- 扩展从 IndexedDB 读取既有 `cases`/`enforcementCases`，复用 `xlsx-io.js` 生成工作簿。
- 保持本地下载；随后复用 `EXPORT_UPLOAD` base64 交接上传服务器，后台 `report_exports` 记录可再次下载。
- 服务器不生成 Excel，不接收密码列以外的未授权真实模板数据；报表文件按 report-export-module 保护。

## 4. REST 契约（`/api/v1`）

除健康检查和登录外均需有效会话：

| 方法 | 路径 | 角色 | 契约 |
|---|---|---|---|
| `POST` | `/browser-commands` | admin,user | 创建任务；类型/参数严格校验；返回 `{command}`；同账号活动任务返回 409 |
| `GET` | `/browser-commands` | admin,user | 后台列表；admin 全部，user 仅本人创建；支持 `status/type/limit/cursor` |
| `GET` | `/browser-commands/:id` | admin,user | 详情；user 仅本人，否则 404 |
| `POST` | `/browser-commands/:id/claim` | extension | `{deviceId}` 领取；返回一次性 claim token（只在响应出现，不落库） |
| `POST` | `/browser-commands/:id/result` | extension | `{deviceId,claimToken,status,resultCode,resultSummary,progress}`；必须 claimant；敏感字段拒绝 |
| `POST` | `/browser-commands/:id/cancel` | admin,user | 创建者可取消 pending/executing；已终态幂等返回 |

- 路径 UUID 与 cursor UUID 在路由边界校验；非法输入返回稳定 400/404，不触发数据库 cast 错误。
- 后台命令 payload 仍不得包含密码、验证码、完整案号、当事人明文或截图；平台凭据与上传模板作为独立受控资源，不复写入 command payload。
- **已确认的内部可见性决策（2026-08-06）**：所有已登录后台用户（`admin`、`user`）均可在后台查看完整上传文件内容、平台账号与平台密码。该能力仅限同源后台 Cookie 会话：extension Bearer 会话不得读取后台明文查看接口；页面/API 使用 `Cache-Control: private, no-store`，不记录正文、不得在命令 payload、任务结果或日志中复制明文。

## 5. 权限矩阵

| 能力 | admin | user | extension |
|---|:---:|:---:|:---:|
| 创建 LOGIN/QUERY/EXPORT | ✓ | ✓ | — |
| 查看本人任务 | ✓ | ✓ | — |
| 查看全部任务 | ✓ | — | — |
| 查看上传模板完整内容、平台账号与平台密码 | ✓ | ✓ | — |
| 领取/回写任务 | — | — | 有效 extension 会话 + claimant |
| 取消本人任务 | ✓ | ✓ | — |
| 取平台凭据用于自动化执行 | 按既有 credential 契约 | 按既有 credential 契约 | 仅有效 extension 会话 |

## 6. 后台页面

新增或合并 `/admin/browser-control`：

- 浏览器连接状态：由扩展心跳/最近回写推断；未知必须显示“未确认”，不得伪造已连接。
- 法院标签状态、登录态、脱敏当前账号。
- 平台账号选择、`远程登录`、`开始立案查询`、`开始强执查询`、`导出报表`。
- 当前任务与历史任务：状态、进度、失败码、待人工原因、取消/重试。
- **模板上传与明文查看**：后台上传真实 xlsx，服务器私有保存并解析为受控批次；所有已登录后台用户均可查看完整文件内容，且可查看平台账号和平台密码。批次列表/创建响应仅返回 `{id,fileName,byteSize,sha256,createdAt,updatedAt,expiresAt,liRows,qzRows,skipped}`，不得返回解析行、账号或密码；明文仅在同源后台 Cookie 会话的专用查看/下载 API 中返回，响应 `Cache-Control: private, no-store`。每个文件最多 20 MiB，解析仅接受无宏 xlsx 的 ZIP 容器；强执表头/必填行/状态规则以 excel-module 为准。不得写入 `browser_commands.payload`、任务结果、客户端日志、服务日志或页面持久化状态；extension Bearer 会话无权访问明文查看 API。
- 报表导出记录继续使用既有 `/admin/report-exports`；业务入口从后台控制台发起。

## 7. 扩展与页面边界

- Service Worker 统一轮询 `browser_commands`；可暂时兼容旧 `login_commands`，完成迁移后再删除兼容层。
- content script 只接受来自扩展消息路由的已校验动作；不接受网页脚本直接创建任务。
- 浮动面板不得显示完整账号、案号、当事人、身份证号、密码、驳回原因；只显示脱敏状态、进度和稳定错误码。
- Chrome 重启、扩展重载、SW 休眠、法院标签关闭时，后台显示未连接/待人工，不伪造成功。

## 8. 测试与验收门槛

### 自动测试

- server：迁移可重复、角色隔离、重复创建、领取/claimant、回写幂等、过期/取消、UUID/cursor 校验、payload 敏感字段拒绝。
- extension：无法院标签、未登录、账号不匹配、LOGIN、QUERY_LI、QUERY_QZ 执行 tab 门禁、EXPORT_REPORT、claimant 回写、SW 配置重建。
- admin：控制台加载、按钮创建指令、任务轮询、隐藏页退避、错误/取消/重试、安全显示。
- manifest：无 `default_popup`；不存在 popup 业务引用；扩展仍能注入法院页面和运行 SW。

### 真实验收

1. 后台点击远程登录，真实法院登录页完成既有 OCR + trusted click 并回写结果。
2. 后台创建立案查询，真实页面执行并回写结果/截图。
3. 后台创建强执查询，非执行 tab 返回 `EXECUTION_TAB_REQUIRED`，执行 tab 才执行。
4. 后台发起导出，后台记录出现且下载 SHA256 与扩展生成文件一致。
5. popup 已移除；扩展 action、后台、法院页面链路正常。
6. 服务器严格使用 `courthelper` 库，`assistant` 库无任何 court-helper 表/序列/迁移对象。

## 9. 范围外

- 不做后台直接调用法院平台 API。
- 不做多浏览器、多租户、SSE/WebSocket、无限重试、离线伪成功。
- 不在本模块中删除旧 `login_commands` 表；待 browser_commands 真实验收和兼容窗口结束后另立迁移任务。
- 不把真实模板、密码、截图、案号或当事人明文写入 Vault/Git/日志。

## 10. 扩展设备授权（v0.7）

### 10.1 安全边界

- 管理员持有有效 `admin_ui` Cookie 会话后，可在 `/admin/browser-control` 显式批准当前扩展设备。
- 配对成功的扩展取得不透明、设备绑定的 Bearer 会话；除用户管理外，可调用现有资源归属、claimant 与 payload 校验允许的全部业务 API。
- **用户管理除外**：每个 `/users*` 端点必须要求管理员 `admin_ui` Cookie、同源请求与 CSRF。即使令牌来自管理员配对的扩展 Bearer 也必须返回 `403 FORBIDDEN`。
- `/admin/*` HTML 及设备管理仍是后台 Cookie 路由；扩展不得取得管理员 Cookie。扩展 Origin/ID 仅是发起配对的条件，而不是授权凭据。

### 10.2 一次性配对合约

```text
extension 生成稳定 deviceId + 随机 32-byte exchangeSecret
  -> POST /auth/extension-pairings（精确配置的 extension Origin）
  -> pairing id + 短核对码（有效期五分钟）
  -> 管理员显式批准相符的 pending pairing
  -> extension 以 pairing id + exchangeSecret 兑换一次
  -> 返回有效期 30 天的设备绑定 Bearer token，SW 启动统一轮询
```

- 服务器仅保存 exchange secret 和核对码的 SHA-256 摘要；明文不得进入数据库记录、日志、命令 payload、后台 HTML、IndexedDB 或 git。
- 状态固定为 `pending`、`approved`、`consumed`、`expired`、`cancelled`。错误、过期或重放数据返回稳定错误且不得签发 token。
- 兑换必须原子消费：同一配对并发兑换最多一个成功。token 明文仅出现在一次兑换响应，扩展仅存入 `chrome.storage.local`。
- 后台撤销设备后，其 session 下一请求即失效；停用、删除或重置配对管理员的密码时也必须撤销该用户的设备 session。
- 配对创建按来源 IP 和设备 ID 限流；同一设备同一时间最多保留一个 `pending` 或 `approved` 配对。新的显式请求会原子取消旧的活动配对，避免后台出现多个可批准核对码。
- 撤销是对原设备 ID 的永久终态：服务端在创建阶段即返回 `DEVICE_REVOKED`，不得让管理员批准一条无法兑换的请求。扩展不会自动重试；只有用户再次点击“请求后台授权”时才轮换到新的随机设备 ID，并再次经管理员核对码审批。

### 10.3 REST 权限矩阵

| 方法 | 路径 | 调用方 | 约束 |
|---|---|---|---|
| `POST` | `/auth/extension-pairings` | 精确 extension Origin | `deviceId`、安全 label、`exchangeSecret` |
| `GET` | `/auth/extension-pairings` | admin_ui admin | 仅安全 pending 摘要 |
| `POST` | `/auth/extension-pairings/:id/approve` | admin_ui admin | Cookie + Origin + CSRF + 核对码 |
| `POST` | `/auth/extension-pairings/:id/exchange` | 精确 extension Origin | exchange secret；一次 token 响应 |
| `GET` | `/auth/extension-devices` | admin_ui admin | 仅安全设备摘要 |
| `POST` | `/auth/extension-devices/:id/revoke` | admin_ui admin | Cookie + Origin + CSRF |
| 任意 | `/users*` | admin_ui admin only | 已配对扩展始终拒绝 |
| 任意 | 其他业务 API | paired extension / existing back office | 现有资源与 claim 校验继续生效 |

### 10.4 自动测试闸门

- 缺少或错误的 Origin、secret、核对码、CSRF、管理员 Cookie 均须拒绝。
- 未批准、过期、已消费、已撤销、重放和并发兑换不得获得第二个 token。
- 管理员配对的 extension token 调用每个 `/users*` 路径均为 403，同时仍可运行 browser-command 轮询和既有执行 API。
- 设备撤销及管理员停用、删除、重置密码须使 token 在下一请求失效，且不泄漏 token 或 secret。
