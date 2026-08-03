# 规格：login-module（登录状态与账号识别）

> 版本：0.1 ｜ 状态：待实现 ｜ 依据：计划 §Phase 2、需求确认（登录全人工）

## 1. 目标

登录**全人工**：操作人员手动在平台上输入账号、密码、验证码完成登录。插件不自动填充、不点击登录按钮、不存储任何凭据，只在登录**之后**提供：登录状态检测、当前账号识别、会话失效检测。

## 2. 范围

| 功能 | 说明 |
|---|---|
| 登录页检测 | 当前 URL hash 匹配 `#/pagesGrxx/pc/login*` → 判定未登录，通知 popup 显示「请手动登录后开始查询」 |
| 登录成功检测 | hash 离开 login 路由 且 出现用户区标志元素 → 判定已登录，通知 popup 解锁查询功能 |
| 当前账号识别 | 从页面用户区读取当前登录账号文本（脱敏处理），与模板「账号」列（C 列）匹配，定位该账号下可查询的行 |
| 会话失效检测 | 平台接口返回 401/会话过期，或页面被跳回 login 路由 → 批量任务暂停，popup 提示人工重新登录 |
| 状态持久化 | 登录状态与当前账号保存在 chrome.storage.local（仅会话信息，无凭据） |

## 3. 范围外（不做）

- 不自动填充账号/密码/验证码，不点击登录按钮，不模拟登录。
- 不存储账号密码（无论明文或加密）——模板 D 列密码仅随导入记录只读保留，不参与任何登录逻辑。
- 不做登录后的自动模块跳转（进入"我的立案审判"由人工或批量任务按 query-module 规格执行）。
- 不处理验证码识别/OCR。

## 4. 选择器与判定（集中在 `extension/content/selectors.js`）

| 键 | 用途 | 当前值 |
|---|---|---|
| `route.login` | 登录页路由匹配 | `#/pagesGrxx/pc/login*`（hash 前缀匹配，已确认） |
| `login.form` | 登录页结构 | 已确认：3 输入框（账号 text / 密码 password / 验证码 text）+ 验证码图片（首个 img）+ 登录按钮；用户类型 tab（个人/律师/法人）；登录方式（扫码/密码）。详见 docs/engineering/platform-recon-2026-08-03.md |
| `userArea` | 用户区标志元素（登录后出现） | **TBD — 真实联调确认** |
| `userAccount` | 当前登录账号文本所在元素 | **TBD — 真实联调确认** |
| `sessionExpiredMark` | 会话失效标志（页面元素或接口响应码） | **TBD — 真实联调确认** |

TBD 项为硬性阻塞：选择器未确认前，对应功能标记「未实现」，不得用猜测的选择器交付。

### 4.1 平台事实（2026-08-03 静态侦察，脱敏）

- 登录 API：`POST /api/v1/login`（参数含 `loginType/username/password/verifyId/code`）；图形验证码 `GET /api/v1/cl/code`；短信 `/api/v1/sms/captcha` + `/api/v1/sms/login`。
- 案件 API：`/api/v1/aj/list`、`/api/v1/aj/detail`、`/api/v1/ajListByUserId`（插件主链路仍走 DOM 采集+截图，API 仅作登录检测/只读校验辅助）。
- 会话存储：`uni storage` 键 `verify`、`loginType`。
- 路由家族：`pagesGrxx/`（个人中心/登录）、`pagesAjkj/`（案件模块）、`pagesOther/`、`pagesCustom/`。
- 「我的立案审判 / 查看强执」入口位置 **未验证**（需已登录会话）。
- 完整记录：`docs/engineering/platform-recon-2026-08-03.md`。

## 5. 消息流

```
content script（平台页，document_start 注入）
  → 路由变化/元素出现 → 状态变更消息
  → service worker 汇总 → chrome.storage.local 更新
  → popup 查询显示「未登录 / 已登录(账号xxx)」
批量任务执行器（app-module）在收到会话失效事件时暂停队列。
```

## 6. 测试

- 单测（node --test）：
  - `isLoginRoute(hash)` 前缀匹配：`#/pagesGrxx/pc/login/index` → true；`#/pagesGrxx/pc/home` → false。
  - 登录成功判定：hash 离开 login 且 userArea 存在 → true。
- mock fixture（simulator）：登录页静态页 + 登录后首页静态页，验证状态切换消息。
- 真实联调（验收闸门）：用户已登录真实会话中核对 userArea/userAccount 选择器与账号文本格式，结果只写脱敏摘要。

## 7. 验收标准

1. 未登录时 popup 显示引导提示，查询/批量按钮禁用。
2. 手动登录后 popup 自动解锁并显示脱敏账号（如 `3503****52X`）。
3. 会话失效时批量任务暂停、popup 提示。
4. 全程无任何凭据写入 storage、日志或 git。
