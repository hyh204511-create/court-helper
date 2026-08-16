# 规格：browser-command-module（后台唯一业务入口与扩展执行代理）

> 版本：0.7 ｜ 状态：已确认、待实现 ｜ 依据：用户明确要求“popup 全部功能转到后台并移除”；Phase 11 控制台唯一入口决策；现有 login-command-bridge、server-module、app-module、panel-module、report-export-module
> v0.2 变更：固定 `/admin/browser-control` 为唯一业务入口；拆分控制台“一键登录”与通用任务区；补充完整名称/凭据查看权限；定义扩展 action 与独立 Options/Setup 路由；要求删除 Popup 源码、产物和测试。
> v0.3 变更：补充已授权 MV3 Service Worker 冷启动时的命令轮询恢复契约，避免后台命令在扩展重载或 Worker 回收后无限停留 `pending`。
> v0.4 变更：真实验收确认 MV3 Worker 回收会丢失仅内存的登录绑定。`EXPORT_REPORT` 因此必须绑定控制台显式选择的非敏感 `platformAccountId`，以便冷启动后仍可按同一账号隔离导出；不持久化平台账号明文、密码或任何业务行。
> v0.5 变更：`LOGIN` 命令在用户已打开的法院标签正跳转到精确登录路由、或新 content script 尚未就绪时，必须在同一已领取命令内有界等待并重连；不得因该瞬态竞态提前回写终态。
> v0.6 变更：新增 `QUERY_ALL_EXPORT` 单一持久化命令，在真实网上立案页内依次切换审判/执行分类、完成两类查询，再生成、下载并上传报表；控制台不再分别创建三种任务。
> v0.7 变更：导出阶段按绑定账号 UUID 临时取得账号标签与真实凭据，校验页面账号后生成账号命名报表；凭据仍不进入持久命令或回执。
> v0.8 变更：`QUERY_ALL_EXPORT` payload 允许且仅使用非敏感 `salesperson` 自由文本，把本次控制台输入传递给报表 U 列；不写入案件库或报表元数据。
> v0.9 变更：`QUERY_ALL_EXPORT` 必须在查询开始前确认本运行期最近一次成功 `LOGIN` 绑定的是同一 `platformAccountId`；未建立绑定返回 `ACCOUNT_BINDING_REQUIRED`，绑定到其他账号返回 `ACCOUNT_MISMATCH`。绑定已确认时，导出不得再把法院页顶栏显示身份与登录用户名做字符串全等比较，因为两者可能分别是姓名/昵称与登录账号。
> v1.1 变更：服务器不再仅凭扩展回写的 `status=succeeded/resultCode=SUCCESS` 接受一键任务成功；`QUERY_ALL_EXPORT` 成功回写必须额外携带 `evidenceClosed=true`。缺失或为 false（包括未重载的旧扩展）由服务器强制归一为 `manual_required/EVIDENCE_NOT_CLOSED`。

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

- popup 不再作为业务入口；从 manifest 移除 `action.default_popup`，删除 `extension/popup/` 全部源码、popup 构建产物和 popup 专用测试，不保留归档副本或第二套兼容业务 UI。
- 后台业务入口固定为 `/admin/browser-control`；`/`、`/admin` 和后台登录成功后都重定向到该页。
- 扩展提供独立 Options/Setup 页面，且只负责服务器地址、设备配对、六位核对码和授权状态；不得承载登录、导入、查询、导出或本地数据检索。
- 法院页面浮动面板仅保留实时状态、进度和人工接管提示，不保留第二套完整导入/查询/导出业务入口。
- 后台不能直接调用法院登录 API，不能直接读取法院 DOM；所有平台动作必须由扩展在真实标签页完成。

## 2. 业务指令模型

新增 PostgreSQL 表 `browser_commands`（迁移 005）：

| 字段 | 约束/含义 |
|---|---|
| `id` | UUID 主键 |
| `type` | `LOGIN` / `QUERY_LI` / `QUERY_QZ` / `EXPORT_REPORT` / `QUERY_ALL_EXPORT`；后三个旧单步类型保留兼容，不再由控制台直接创建 |
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
- `QUERY_ALL_EXPORT` 的结果请求仅在 `status=succeeded` 时强制要求布尔证明 `evidenceClosed=true`。服务器必须在写入终态前执行该检查；缺失或 false 不得保存成功，统一改写为 `manual_required`、`result_code=EVIDENCE_NOT_CLOSED`、安全摘要“证据未完成服务器闭环”。该字段不得用于 `LOGIN`、单类型查询或独立 `EXPORT_REPORT` 的成功判定，也不得携带案件、截图或联系人内容。
- 扩展在命令执行期间写入案件、截图和报表时，必须携带命令 ID、设备 ID 与一次性 claim token；服务端以 `requested_by` 作为资源归属，而不是以执行设备的配对用户作为归属。案件与截图只接受 `QUERY_LI`、`QUERY_QZ`、`QUERY_ALL_EXPORT` 租约，报表只接受 `EXPORT_REPORT`、`QUERY_ALL_EXPORT` 租约；`LOGIN` 等错误命令类型必须返回 `403 FORBIDDEN`。
- 旧 `login_commands` 在迁移期间保留兼容；本模块不直接删除旧表。

## 3. 指令类型契约

### `LOGIN`

- 后台只提交 `platformAccountId`。
- 扩展领取后：检查用户已打开的法院标签 → 有界等待同一标签进入精确登录路由 → 取平台凭据 → 有界确认新 content script 就绪并执行既有 `AUTO_LOGIN` → OCR/可信点击链路不变 → 回写成功或稳定失败码。
- 页面路由或 content script 的就绪等待仅允许复用同一已打开法院标签、同一 claim 和有界重试（默认最多 8 次、每次间隔 500ms）；扩展不得自行导航、刷新页面、创建标签页或无限重试。等待超时回写 `LOGIN_PAGE_TIMEOUT` 或 `LOGIN_CONTENT_UNAVAILABLE`，均为待人工；不得取凭据、记录凭据或伪造成功。
- 密码只在服务器凭据出口到扩展运行时内存链路流转，不进入 command payload、storage、日志或后台 HTML。
- Service Worker 仅在同一运行期内保存最近一次成功 `LOGIN` 的不透明 `platformAccountId`，不持久化、不记录真实账号或密码。`QUERY_ALL_EXPORT` 在读取导入批次、临时凭据、查询页面或采集凭证前必须校验该绑定：绑定缺失返回 `ACCOUNT_BINDING_REQUIRED`，绑定到其他账号返回 `ACCOUNT_MISMATCH`；两者均不得读取上述数据或开始查询。单独 `QUERY_LI` / `QUERY_QZ` 保留手工登录兼容，但已有绑定且目标 ID 不一致时仍返回 `ACCOUNT_MISMATCH`。

### `QUERY_LI` / `QUERY_QZ`

- 后台选择查询类型、目标平台账号和**已存在、未过期的 `importBatchId`**。服务端创建命令时将该 UUID 写入 `clientBatchId`；不得接受客户端自由字符串作为查询批次引用。
- `QUERY_LI` / `QUERY_QZ` 可绑定当前类型 `liRows` / `qzRows` 为零的合法空白模板。零行是“平台发现模式”，不是无效批次；创建、重试和扩展执行不得以 `no_rows_for_query_type` 或 `NO_CASES` 拒绝任务。仍不得在错误、命令 payload 或普通历史接口中返回业务行内容。
- 当前查询类型存在任何业务数据行时，服务端创建或重试必须以稳定码 `TEMPLATE_NOT_EMPTY` 拒绝；不得退回旧的导入行驱动查询。已领取的历史非空任务在扩展端也必须转人工，禁止按原告、账号或标题作模糊匹配。
- 后台的创建与历史查询任务重试可展示批次行数作为摘要，但零行必须显示“平台发现（空模板）”并允许发送请求。
- 批次绑定在命令创建时由服务器校验；后续 extension 读取批次执行数据时必须同时校验：命令处于 `executing`、`claimed_by` 与 claim token 匹配、命令的 `clientBatchId` 与请求批次一致且批次未过期。
- `QUERY_LI` 与 `QUERY_QZ` 只允许网上立案列表。
- `QUERY_QZ` 与 `QUERY_LI` 都只选择精确“网上立案”列表路由；只有“我的案件”标签时回写 `ONLINE_FILING_PAGE_REQUIRED`。网上立案页当前可见行不存在执行类 `caseType` 时，`QUERY_QZ` 必须回写 `EXECUTION_TAB_REQUIRED`，不得继续执行、不得自动切 tab。
- 扩展继续复用既有 `START_BATCH`、`runBatch`、状态识别、截图、节流（3–8 秒/案、单批 50、重试 1）。空模板发现先从当前真实列表建立当前账号隔离的记录集，再调用同一采集链路；预取验证失败不得清空旧数据。
- 查询结果经既有 sync/outbox 上传；未知状态保持 `UNKNOWN + needsHuman=true`。

**单路由结构化执行**：`QUERY_LI` 与 `QUERY_QZ` 均在精确“网上立案”列表路由内完成发现、截图及 `ajlist` F/G 补证；不得导航到“我的案件”，不得发送 `queryPhase: "mycase_evidence"` 第二阶段消息。内容端口关闭只按有界的 `CONTENT_UNAVAILABLE` 失败处理，不复用 claim 做跨路由重发。

**查询执行租约**：`QUERY_LI` / `QUERY_QZ` 的单次 claim 固定 20 分钟，无心跳续租。该期限覆盖单批最多 50 条、每案 3–8 秒的采集、结构化分页补证及回写余量。租约到期前未回写的命令由服务端标记为 `expired`，不得用新 claim 或无限重试掩盖。

### `EXPORT_REPORT`

- `EXPORT_REPORT` 与 `QUERY_ALL_EXPORT` 进入导出阶段前，SW 必须按 `platformAccountId` 从扩展专用出口临时读取 `{label,account,password}`；只向本次受信 content 消息传递，执行结束即释放。任何命令 payload、持久 storage、任务结果、进度、错误摘要和日志均不得包含这些明文。
- 兼容 `EXPORT_REPORT` 未携带绑定证明时仍须精确校验页面顶栏账号等于凭据账号；`QUERY_ALL_EXPORT` 已通过同运行期 `LOGIN` UUID 绑定证明时不得重复比较这两段语义不同的文本。两条路径都只用临时凭据覆盖工作簿 C/D 列并以净化后的标签命名文件；校验或取凭据失败不得下载、上传或回写伪成功。

- 控制台创建导出任务时必须显式选择平台账号；服务端将其不透明 UUID 写入既有 `browser_commands.platform_account_id`。该 UUID 不是账号明文或凭据，禁止写入 payload、扩展 storage、日志或任务摘要。
- `QUERY_ALL_EXPORT` 以命令携带的 `platformAccountId` 执行并依赖本运行期成功 `LOGIN` 绑定；Worker 冷启动、扩展重载或配置重建导致绑定丢失时，必须在采集前返回 `ACCOUNT_BINDING_REQUIRED`，由用户先对同一后台账号执行一次一键登录再重试。不得在身份未确认时恢复查询并把错误拖到导出阶段。
- content 必须同时使用当前真实页面顶栏账号和命令的 `platformAccountId` 过滤两张本地案件表；账户不一致或没有该账号隔离的数据时按既有稳定错误码失败，禁止混入其他账号 UUID 的记录。
- content 必须同时按真实页面顶栏账号和该 `platformAccountId` 查询两张本地案件表；相同页面账号名但不同后台账号 UUID 的记录绝不能混入同一份报表。
- 扩展从 IndexedDB 读取既有 `cases`/`enforcementCases`，复用 `xlsx-io.js` 生成工作簿。
- 保持本地下载；随后复用 `EXPORT_UPLOAD` base64 交接上传服务器，后台 `report_exports` 记录可再次下载。
- 服务器不生成 Excel，不接收密码列以外的未授权真实模板数据；报表文件按 report-export-module 保护。

### `QUERY_ALL_EXPORT`

- 控制台必须同时提交 `platformAccountId` 与未过期的 `importBatchId`；该批次的立案、强执业务行必须同时为 0，否则以 `TEMPLATE_NOT_EMPTY` 拒绝。命令沿用 `client_batch_id`、账号活动唯一约束和敏感 payload 禁止规则，不新增工作流表或业务快照。
- 控制台同时提交 `payload.salesperson`：字符串首尾空白清理后长度为 1–100 个字符。Service Worker 只把它传给本次受信 content 导出调用；content 将其写入所有业务数据行 U 列。不得从模板、平台 DOM 或案件字段回填，且不得写入 IndexedDB、任务结果、进度或报表元数据。
- Service Worker 只领取和下发一次命令，并只读取一次受 claim 约束的批次执行数据；命令执行租约为 40 分钟。页面刷新、Worker 中断或浏览器关闭不做中途断点续跑，命令按既有规则过期后由用户显式重试并从立案阶段重新执行。
- content 在精确网上立案列表路由中依次执行：精确切换“审判”分类并点击查询 → 立案平台发现/采集 → 精确切换“执行”分类并点击查询 → 强执平台发现/采集 → 按同一页面账号和 `platformAccountId` 生成、下载、上传报表。
- tab 文字必须修剪后全等，目标元素和查询按钮必须唯一、可见、可点；切换后等待列表稳定最多 10 秒，每个切换/查询动作最多重试 1 次。元素缺失/重复、列表未稳定、会话/账号/路由错误、选择器变化、API/DOM 不一致等硬失败立即停止且不得导出。
- 单条案件 `UNKNOWN`、证据缺失或截图失败继续保留 `needsHuman` 和精确错误码，不阻断另一类型采集及最终导出；报表继续按既有红色待人工规则呈现，不得猜测补齐。只有经结构化总数与当前分类 DOM 一致确认的 0 条结果可原子清空该账号该类型旧记录并作为成功空阶段；两类最终均为 0 时仍由导出层返回 `REPORT_EMPTY` 且不下载、不上传。
- 每个分类阶段必须返回显式 `evidenceClosed=true`：非空阶段表示每条案件同步均取得本次可验证服务器收据，且每条终态记录的对应截图已入库并确认通知台账；空阶段仅在结构化总数与 DOM 同时确认 0 条时成立。任一阶段缺少该标记、存在无完整收据的遗留 `sent` 事件，或案件/截图 ACK 不完整时，`runQueryAllExport` 必须以 `EVIDENCE_NOT_CLOSED` 停止，禁止生成、下载或上传报表。
- Service Worker 回写 `QUERY_ALL_EXPORT` 结果时必须再次检查 `evidenceClosed=true`。即使 content 返回 `status=uploaded`，缺少闭环标记也只能回写 `manual_required/EVIDENCE_NOT_CLOSED`，不得以“报表已上传服务器”伪报任务成功。旧 `EXPORT_REPORT` 仅导出既有数据，不适用本次查询闭环标记。

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
| `DELETE` | `/browser-commands` | admin,user | 二次确认后的批量清理；admin 删除全部已结束任务，user 仅删除本人已结束任务；返回 `{deletedCount}`，不得删除 pending/executing 或其他资源 |

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
| 清空有权查看的已结束任务 | ✓（全部） | ✓（仅本人） | — |
| 取平台凭据用于自动化执行 | 按既有 credential 契约 | 按既有 credential 契约 | 仅有效 extension 会话 |

## 6. 后台页面

新增或合并 `/admin/browser-control`：

- 控制台只展示统一命令的真实状态、进度和稳定结果码。当前没有独立扩展心跳/法院标签心跳，因此不得渲染永远停在“未确认”的浏览器连接、法院标签或登录态占位卡；后续若新增可验证心跳，必须另立规格和测试。
- **平台账号与自动登录**：只列出启用平台账号；选择账号后，“一键登录”只创建统一 `LOGIN` 命令。平台账号管理页不得再提供“远程登录”按钮或登录指令列表。
- **一键查询导出区**：只保留账号、空白批次、业务员自由文本输入与“一键查询并导出”按钮，固定创建 `QUERY_ALL_EXPORT`；业务员必填且最大 100 个字符，不得混入 `LOGIN` 或独立任务类型选择器。
- 当前任务与历史任务：状态、进度、失败码、待人工原因、取消/重试，并显示完整任务创建者用户名；页面同时显示当前后台会话的完整用户名，不做掩码。
- 任务列表显示平台账号标签；控制台提供进入 `/admin/cases` 案件台账的明确链接，但不得在控制页重复调用案件列表 API、实现案件分页或渲染案件状态。任务 `succeeded` 只表示命令执行完成，不得替代案件状态或推断“立案成功”。
- 提供“清空已结束任务”操作：浏览器原生二次确认后发送 `DELETE /browser-commands`；提交期间禁用按钮，成功后显示实际删除条数并重新读取列表。服务端按角色限制删除范围且始终保留 `pending/executing`；案件、截图、导入批次、报表和账号均不受影响。
- **平台凭据按需查看**：admin、user 的同源 `admin_ui` Cookie 会话均可查看选中平台账号的完整账号和密码；明文只用 `textContent` 渲染，关闭/切换账号/离开页面立即清空。
- **模板上传与明文查看**：后台上传真实 xlsx，服务器私有保存并解析为受控批次；所有已登录后台用户均可查看完整文件内容，且可查看平台账号和平台密码。批次列表/创建响应仅返回 `{id,fileName,byteSize,sha256,createdAt,updatedAt,expiresAt,liRows,qzRows,skipped}`，不得返回解析行、账号或密码；明文仅在同源后台 Cookie 会话的专用查看/下载 API 中返回，响应 `Cache-Control: private, no-store`。每个文件最多 20 MiB，解析仅接受无宏 xlsx 的 ZIP 容器；强执表头/必填行/状态规则以 excel-module 为准。不得写入 `browser_commands.payload`、任务结果、客户端日志、服务日志或页面持久化状态；extension Bearer 会话无权访问明文查看 API。
- 报表导出记录继续使用既有 `/admin/report-exports`；业务入口从后台控制台发起。

## 7. 扩展与页面边界

- Service Worker 统一轮询 `browser_commands`；可暂时兼容旧 `login_commands`，完成迁移后再删除兼容层。
- **冷启动轮询恢复**：每次 Service Worker 模块加载时，均须先注册/恢复 `browser-command-poll` alarm，并立即尝试一次命令领取；不得只依赖浏览器 `onStartup`、扩展 `onInstalled`、storage 变更或内容脚本消息。已配置、未过期的设备 Bearer 令牌必须在 Worker 被回收后继续领取 `pending` 命令；未配置、过期或撤销的令牌不得发送领取请求、不得伪造任务终态。
- 冷启动恢复仅复用既有 `GET /browser-commands/next`、claim 和结果回写契约；不增加心跳接口、SSE/WebSocket、无限重试或后台直接操作法院页面。领取后仍须经过既有法院路由、内容脚本和账号绑定门禁。
- manifest `action` 不配置 `default_popup`。点击扩展图标时：本机服务器地址已配置且设备授权仍有效 → 新标签打开 `http://127.0.0.1:3000/admin/browser-control`；未配置、配对中、授权过期或已撤销 → 打开独立 Options/Setup 页面。
- Options/Setup 只允许规范化的 `http://127.0.0.1:3000` 根地址；保持 host 权限 `http://127.0.0.1:3000/*`，不得增加 `<all_urls>`。
- content script 只接受来自扩展消息路由的已校验动作；不接受网页脚本直接创建任务。
- 同时存在多个法院标签页时，Service Worker 必须在符合精确路由门禁的候选中优先选择 `active=true` 的标签；没有活动法院标签时选择 `lastAccessed` 最大的最近使用标签。禁止依赖 `tabs.query()` 的数组顺序把查询发送到错误列表页；候选缺少 `lastAccessed` 时保持确定性回退。执行查询/导出前须激活选中的法院标签，确保交互和目标 DOM 截图发生在该任务页；激活失败则返回稳定错误，不得把命令发送到后台控制台或其他标签。
- 浮动面板不得显示完整账号、案号、当事人、身份证号、密码、驳回原因；只显示脱敏状态、进度和稳定错误码。
- Chrome 重启、扩展重载、SW 休眠、法院标签关闭时，命令保持真实 pending/failed/manual_required 等状态并显示稳定结果码，不从缺失的心跳推断实时连接状态或伪造成功。

## 8. 测试与验收门槛

### 自动测试

- server：迁移可重复、角色隔离、重复创建、领取/claimant、回写幂等、过期/取消、UUID/cursor 校验、payload 敏感字段拒绝。
- extension：无法院标签、未登录、账号不匹配、LOGIN、QUERY_LI、QUERY_QZ 执行 tab 门禁、EXPORT_REPORT、claimant 回写、SW 配置重建；多法院列表标签必须选择活动标签或最近使用标签；LOGIN 必须覆盖登录路由跳转期间的有界等待、content script 首次未就绪后的有界重连，以及两种超时的脱敏待人工回写。
- extension：模拟已授权配置下的 Service Worker 冷启动（不触发 `onStartup` 或 `onInstalled`）时，必须立即请求 `/browser-commands/next` 并领取可执行命令；缺少/过期令牌时不得发起该请求。
- admin：`/`、`/admin`、登录成功入口跳转；控制台独立一键登录；通用任务区无 LOGIN；完整当前用户名/创建者名称与平台账号标签；控制台不请求案件列表且可进入唯一案件台账；两种角色凭据按需查看；跨域、未登录和 extension Bearer 拒绝；无缓存响应；任务轮询、隐藏页退避、错误/取消/重试/清空已结束任务、安全显示。
- manifest：无 `default_popup`；不存在 popup 源码、构建入口、产物和测试；已授权 action 打开控制台，未授权 action 打开 Options/Setup；扩展仍能注入法院页面和运行 SW。

### 真实验收

1. 后台控制台点击“一键登录”，真实法院登录页完成既有 OCR + trusted click 并回写结果。
2. 后台创建立案查询，真实页面执行并回写结果/截图。
3. 后台创建强执查询，非执行 tab 返回 `EXECUTION_TAB_REQUIRED`，执行 tab 才执行。
4. 后台发起导出，后台记录出现且下载 SHA256 与扩展生成文件一致。
5. popup 已移除；已授权 action 打开控制台，未授权 action 打开 Options/Setup；后台、法院页面链路正常。

## 11. 历史物理删除（v0.8）

- `DELETE /browser-commands/:id` 仅允许删除已结束任务；活动任务返回 `TASK_ACTIVE`。admin 可删除可见记录，user 仅可删除本人记录，成功返回 `{deletedCount:1}`。
- `DELETE /browser-commands?type=QUERY_ALL_EXPORT` 仅物理删除已结束的一键查询并导出历史；任务列表同时提供逐条删除和二次确认的一键批量删除，重新读取后不得继续占用列表位置。
- `DELETE /auth/extension-devices/:id` 与 `DELETE /auth/extension-devices` 仅限 admin_ui admin；删除前撤销设备 session、取消 pending/approved 配对，随后物理删除设备记录并返回 `{deletedCount}`。重新读取授权列表不得再出现已删除设备。
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
- 独立 Options/Setup 页面必须提供可编辑的“服务器地址”输入框；当前本机验收仅接受并规范化为 `http://127.0.0.1:3000`，在用户点击“请求后台授权”时将地址交给 SW 原子保存后再发起配对。非法地址不得发起网络请求或生成待批准设备。
- 地址变更或停用必须使旧统一轮询的在途网络/内容执行失效；旧轮询返回 `401` 时不得清除新地址已配对设备的 token、不得向旧服务器回写结果。

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
### QUERY_ALL_EXPORT 就绪闸门（v0.9）

- Service Worker 在同一已领取命令内，向精确“网上立案”标签发送有界 `PING`，必须确认 content script 已注册、面板已挂载、当前平台账号可识别且列表分类/查询控件唯一可用后，才下发唯一一次 `BROWSER_COMMAND_EXECUTE`。
- 就绪探测默认最多 8 次、每次间隔 500ms、单次响应最多 2s；探测期间不得导航、刷新、创建标签或重复领取命令。超时回写 `CONTENT_UNAVAILABLE`，不得把未执行误报为成功。
- content 的 `PING` 仅返回脱敏路由、登录状态和布尔 `ready`；不得返回账号明文、业务行、凭据或 DOM 内容。该闸门只解决 SPA/content script 初始化竞态，不改变查询分类切换、采集、导出和租约规则。

### 导出凭据滚动升级兼容（v1.0）

- 自动化凭据出口的稳定最小响应为 `{account,password}`；`label` 是可选的非敏感加法字段，不得作为凭据获取成功的硬门槛。
- `QUERY_ALL_EXPORT` 与兼容 `EXPORT_REPORT` 优先使用凭据响应中的 `label`。旧服务未返回 `label` 时，Service Worker 必须调用现有平台账号列表接口，并按命令绑定的 `platformAccountId` 精确匹配唯一标签。
- 标签无法精确取得时回写稳定码 `ACCOUNT_LABEL_UNAVAILABLE`，不得使用真实登录账号、UUID 或猜测值作为文件名，也不得继续下载或上传。
- 凭据接口返回 `401/AUTH_REQUIRED` 时沿用轮询层授权失效处理；`404`、`409 ACCOUNT_DISABLED`、`503 CREDENTIAL_UNAVAILABLE` 映射为不含响应正文的稳定码。任何错误回执、日志、命令结果与存储均不得包含账号密码。
- 发布顺序采用服务器先于扩展；自动测试必须覆盖“旧服务 `{account,password}` + 新扩展”和“新服务 `{label,account,password}` + 新扩展”两种组合。
