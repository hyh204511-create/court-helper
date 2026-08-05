# 规格：login-command-bridge（后端管理系统远程一键登录）

> 版本：0.1 ｜ 状态：待实现 ｜ 依据：用户决策（2026-08-05「要，做指令桥接：后端管理系统能选账号发起一键登录」）、login-module v0.5（trusted click 链路已验收）
> 前置依赖：login-module v0.5（chrome.debugger 真实点击）、server-module Phase 9（平台账号/凭据/管理 UI）

## 1. 目标

操作员在**后端管理系统**（`/admin`）选择平台账号并发起「一键登录」，由**本机浏览器扩展**执行真实登录（复用 login-module v0.5 链路：取凭据 → 填表 → OCR → debugger 真实点击），结果回写管理系统展示。

**本质**：后端管理系统是"指令发起方"，扩展是"执行方"。二者经服务器上的**登录指令队列**桥接（浏览器安全模型下管理系统网页无法直接操作浏览器页面，故用轮询指令模式）。

## 2. 范围

| 功能 | 说明 |
|---|---|
| 创建登录指令 | 管理 UI：平台账号行「远程登录」按钮 → `POST /login-commands`（admin 权限；同账号存在未过期 pending/executing 指令时返回 409） |
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

- **启用条件**：storage 存在服务器配置（`serverUrl`/`serverUsername`）+ **远程登录已启用**（storage `remoteLoginEnabled: true`，由 popup「启用远程登录」开关写入；启用时用户需输入服务器密码获取 extension token，**token 存 storage.local 带 `expiresAt`（TTL 8h）**；token 过期/失效 → 轮询暂停 + popup 提示重新启用）。
- **轮询间隔**：3s（`setInterval`）；SW 被唤醒（startup/onMessage 触发）时立即检查一次。
- **执行流程**：
  1. `GET /login-commands?status=pending`（Bearer token）；
  2. 无指令 → 结束；有 → `tabs.query({url: 法院平台})` 找登录页 tab（`isLoginRoute`）；无匹配 tab → 回写 `failed{code: NO_TAB}`；
  3. `POST /platform-accounts/:id/credential` 取凭据（extension 会话，内存流转）；
  4. 发 `AUTO_LOGIN` 给 content（复用 login-module 消息契约：account/password/serviceUrl）；
  5. content 回执 → `POST /login-commands/:id/result` 回写（成功 → success；NEEDS_HUMAN/FORM_NOT_READY → failed + code）。
- **单飞**：SW 同时只执行一条指令（in-flight 标记），执行期间轮询暂停。
- **与 popup 并发**：popup 手动登录进行中（AUTO_LOGIN 已在 content 执行）时，指令领取后回写 `failed{code: BUSY}`（content 单飞由 login-auto 的 activeLogin 保证，SW 在发消息前查不到 activeLogin 状态，故用内容回执判定；实际以 content 返回为准，若返回 FORM_NOT_READY 且页面已登录路由则原样回写）。
- **已登录处理**：领取指令后先 PING content 查 `state`——`logged-in` → 直接回写 `success`（幂等，不重复执行）；`login` → 执行 AUTO_LOGIN。

## 7. 管理 UI 交互

- 平台账号列表每行新增「远程登录」按钮（enabled 账号可点）→ 点击后行内状态变「指令已创建」→ 轮询该指令状态（2s，≤60s）显示：执行中 / 成功（绿）/ 失败（红 + code）。
- 账号详情页或新「登录指令」区：最近 100 条指令表（账号 label、状态、结果、时间）。
- 文案不含凭据；失败只显示 code 与脱敏 message。

## 8. 安全

- 指令**不携带凭据**；凭据仍走 `POST /platform-accounts/:id/credential`（extension 会话，内存流转，`Cache-Control: no-store`）。
- 服务器登录 token 存 storage 是**用户显式启用**后的选择（TTL 8h），popup 提供「停用远程登录」即清除 token；平台账号密码永不落 storage。
- `claimed_by` 存脱敏标识（如 `dev-<8位hex>`），不回显完整会话信息。
- 管理 UI 创建/查看指令：admin 权限 + CSRF；extension 领取/回写：extension 会话 + claimed_by 归属校验。

## 9. 测试

- 服务器（node --test）：
  - repository/service：创建、同账号 pending 去重 409、领取原子性（并发两笔只成功一笔）、租约超时回退、过期标记、回写成功/失败、非领取人回写 403。
  - routes：权限矩阵（admin 创建/列表、extension 领取/回写）、CSRF、401/403。
  - UI 冒烟：页面含「远程登录」按钮（DOM 断言）。
- 扩展（node --test，mock chrome.tabs/chrome.storage/fetch）：
  - poll：无指令 → 不发 AUTO_LOGIN；有指令 + 登录页 tab → 取凭据 → AUTO_LOGIN → 回写 success；无 tab → NO_TAB 回写；content 返回 NEEDS_HUMAN → failed 回写；已登录 → 幂等 success；单飞（执行中不重复领取）。
  - token 管理：过期 → 暂停轮询；停用开关 → 清 token。
- 迁移：003 up/down 可往返。
- 真实验收（闸门）：管理 UI 点「远程登录」→ 本机 Chrome 自动登录成功 → UI 显示成功。

## 10. 验收标准

1. 管理 UI 对启用账号发起远程登录 → 本机浏览器自动登录成功 → UI 状态 success。
2. 同账号重复发起 → 409 提示已有未完成指令。
3. 无浏览器 tab/未登录页 → failed(NO_TAB) 展示。
4. 停用远程登录 → 轮询停止、token 清除、popup 明示。
5. 全程无凭据落 storage/git/vault；指令表不含账号密码。
