# 规格：login-command-bridge（后端管理系统远程一键登录）

> 版本：0.2 ｜ 状态：兼容保留、业务入口已迁移 ｜ 依据：既有远程登录桥接、Phase 11 控制台唯一入口决策
> v0.2 变更：平台账号页“远程登录”和登录指令 UI 删除；新业务入口只在 `/admin/browser-control` 创建统一 `LOGIN` browser command。旧 `login_commands` 表/API/执行器只按 browser-command-module 的兼容窗口保留。
> 前置依赖：login-module v0.5（chrome.debugger 真实点击）、server-module Phase 9（平台账号/凭据/管理 UI）

## 1. 目标

操作员在**后端管理系统**（`/admin`）选择平台账号并发起「一键登录」，由**本机浏览器扩展**执行真实登录（复用 login-module v0.5 链路：取凭据 → 填表 → OCR → debugger 真实点击），结果回写管理系统展示。

**本质**：后端管理系统是"指令发起方"，扩展是"执行方"。二者经服务器上的**登录指令队列**桥接（浏览器安全模型下管理系统网页无法直接操作浏览器页面，故用轮询指令模式）。

## 2. 范围

| 功能 | 说明 |
|---|---|
| 创建登录指令 | 兼容 API `POST /login-commands` 暂时保留但无管理 UI 入口；新请求必须由控制台“一键登录”创建 `LOGIN` browser command |
| 领取指令 | 扩展 SW 轮询 `GET /login-commands?status=pending`（extension 会话）→ 服务器返回最早一条并标记 `executing`（租约 60s，超时未回执 → 可被重新领取） |
| 执行登录 | 扩展 SW 收到指令 → 复用 AUTO_LOGIN 链路（取凭据 → 找法院登录页 tab → content 执行 trusted click 登录） |
| 回写结果 | `POST /login-commands/:id/result`（extension 会话，校验领取人）→ `success` 或 `failed{code}`；管理 UI 展示状态 |
| 指令列表 | 管理 UI 显示最近 100 条指令（账号/发起人/状态/时间/结果） |
| 过期清理 | pending 超过 5 分钟 → 查询时惰性标记 `expired`；executing 租约 60s 超时 → 回退 `pending` 可重领 |

## 3. 范围外（不做）

- 多浏览器/多执行器并发领取（单机单扩展场景；指令按创建时间最早领取，执行器互斥由租约保证）。
- 管理 UI 直接填写/查看平台账号密码（沿用既有凭据出口，指令不携带任何凭据）。
- 登录指令自动重试（失败即 failed，人工决定是否重发）。
- 滑块/行为验证码等平台侧验证（沿用 login-module 范围外）。
- 指令的 WebSocket/SSE 实时推送（轮询即可，本期不做推送通道）。

## 4. 数据模型（003_login_commands）

```sql
CREATE TABLE IF NOT EXISTS login_commands (
  id UUID PRIMARY KEY,
  platform_account_id UUID NOT NULL REFERENCES platform_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','executing','success','failed','expired')),
  result_code TEXT,           -- failed 时的错误码（NEEDS_HUMAN/FORM_NOT_READY/...）
  result_message TEXT,        -- 脱敏说明
  claimed_by TEXT,            -- 领取人标识（extension 会话 deviceId，脱敏存储）
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL   -- created_at + 5min（pending 过期点）
);
CREATE INDEX IF NOT EXISTS login_commands_status_idx ON login_commands (status, created_at);
```

## 5. API 契约（前缀 `/api/v1`）

| 端点 | 权限 | 语义 |
|---|---|---|
| `POST /login-commands` body `{platformAccountId}` | admin（cookie+CSRF） | 创建指令；同账号存在未过期 pending/executing → 409 `DUPLICATE_PENDING`；响应 `{id, status, createdAt}` |
| `GET /login-commands?status=pending` | extension 会话 | 领取：返回最早一条 pending 并原子置 `executing` + 记录 `claimed_by` + `expires_at = now()+60s`；无 → `{commands: []}`；响应 `{command: {id, platformAccountId} \| null}` |
| `POST /login-commands/:id/result` body `{ok: boolean, code?: string, message?: string}` | extension 会话（claimed_by 匹配） | 回写：ok=true → `success`；false → `failed` + code/message（message 脱敏截断 200 字）；非领取人 → 403 |
| `GET /login-commands?limit=100` | admin | 最近列表（按 created_at desc）：`{commands: [{id, accountLabel, status, resultCode, createdAt, updatedAt}]}` |

- 租约回退：`GET status=pending` 时顺带把 `executing AND updated_at < now()-60s` 的指令回置 `pending`（原子 UPDATE ... WHERE 条件）。
- 过期：`GET status=pending` 时顺带把 `pending AND expires_at < now()` 置 `expired`。

## 6. 扩展 SW 轮询契约（extension/sw/login-command-poll.js）

- **启用条件**：仅在迁移兼容窗口内使用已配对扩展设备的 `serverUrl`、opaque token 与 `remoteLoginEnabled`；不再存在 Popup 开关、服务器用户名/密码登录或 8 小时旧 token 配置入口。新统一轮询以 browser-command-module 为准。
- **轮询间隔**：3s（`setInterval`，SW 存活时快轮询）；另用 `chrome.alarms` 每 1 分钟兜底唤醒并执行一次检查。
- **执行流程**：
  1. `GET /login-commands?status=pending`（Bearer token）；
  2. 无指令 → 结束；有 → `tabs.query({url: 法院平台})` 找登录页 tab（`isLoginRoute`）；无匹配 tab → 回写 `failed{code: NO_TAB}`；
  3. `POST /platform-accounts/:id/credential` 取凭据（extension 会话，内存流转）；
  4. 发 `AUTO_LOGIN` 给 content（复用 login-module 消息契约：account/password/serviceUrl）；
  5. content 回执 → `POST /login-commands/:id/result` 回写（成功 → success；NEEDS_HUMAN/FORM_NOT_READY → failed + code）。
- **单飞**：SW 同时只执行一条指令（in-flight 标记），执行期间轮询暂停。
- **与统一命令并发**：content 的 `activeLogin` 继续保证 AUTO_LOGIN 单飞；旧兼容指令与新 `LOGIN` 同时到达时，后到者回写稳定 `BUSY`/待人工，不得并发填表。
- **已登录处理**：领取指令后先 PING content 查 `state`——`logged-in` → 直接回写 `success`（幂等，不重复执行）；`login` → 执行 AUTO_LOGIN。

## 7. 管理 UI 迁移

- `/admin/platform-accounts` 不得出现“远程登录”按钮或“登录指令”列表。
- `/admin/browser-control` 的“平台账号与自动登录”区域选择启用账号并创建统一 `LOGIN`；状态只在统一 browser command 列表展示。
- 文案不含凭据；失败只显示稳定 code 与脱敏 message。

## 8. 安全

- 指令**不携带凭据**；凭据仍走 `POST /platform-accounts/:id/credential`（extension 会话，内存流转，`Cache-Control: no-store`）。
- 扩展凭据来源改为后台批准的设备会话；不再配置服务器账号角色。配对 token 可调用自动化凭据出口，但不得调用后台 `credential-view`。
- 配对 token 按扩展设备授权规格存 storage；Options/Setup 可重新请求授权，但不提供“停用远程登录”业务开关。平台账号密码永不落 storage。
- `claimed_by` 存脱敏标识（如 `dev-<8位hex>`），不回显完整会话信息。
- 管理 UI 创建/查看指令：admin 权限 + CSRF；extension 领取/回写：extension 会话 + claimed_by 归属校验。

## 9. 测试

- 服务器（node --test）：
  - repository/service：创建、同账号 pending 去重 409、领取原子性（并发两笔只成功一笔）、租约超时回退、过期标记、回写成功/失败、非领取人回写 403。
  - routes：权限矩阵（admin 创建/列表、extension 领取/回写）、CSRF、401/403。
  - UI 冒烟：平台账号页不含“远程登录”与登录指令区；控制台含独立“一键登录”并创建统一 LOGIN。
- 扩展（node --test，mock chrome.tabs/chrome.storage/fetch）：
  - poll：无指令 → 不发 AUTO_LOGIN；有指令 + 登录页 tab → 取凭据 → AUTO_LOGIN → 回写 success；无 tab → NO_TAB 回写；content 返回 NEEDS_HUMAN → failed 回写；已登录 → 幂等 success；单飞（执行中不重复领取）。
  - token 管理：过期 → 暂停轮询；停用开关 → 清 token。
- 迁移：003 up/down 可往返。
- 真实验收（闸门）：控制台点“一键登录”→ 本机 Edge 自动登录成功 → 统一任务 UI 显示成功。

## 10. 验收标准

1. 控制台对启用账号发起统一 LOGIN → 本机浏览器自动登录成功 → UI 状态 success。
2. 同账号重复发起 → 409 提示已有未完成指令。
3. 无浏览器 tab/未登录页 → failed(NO_TAB) 展示。
4. 设备撤销/授权过期 → 统一轮询停止；扩展 action 与 Options/Setup 明确回到未授权状态。
5. 全程无凭据落 storage/git/vault；指令表不含账号密码。
