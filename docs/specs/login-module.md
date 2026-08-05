# 规格：login-module（登录状态、账号识别与自动登录）

> 版本：0.4 ｜ 状态：实现中 ｜ 依据：计划 §Phase 2、需求确认（2026-08-04 用户拍板「升级规则：全面自动登录」）、Phase 9 服务器上线（2026-08-05 用户拍板「自动登录凭据从服务器取」）
> v0.2 变更：登录全人工 → 登录自动化（可选）；新增自动登录范围、本地服务、验证码识别流程。
> v0.3 变更：**自动登录凭据来源改为服务器**（`GET /platform-accounts` 列表 + `POST /platform-accounts/:id/credential` 取明文）；验证码 OCR 仍走本地 8765 服务（ddddocr）；本地 `accounts.txt` 降级为可选回退。
> v0.4 变更：**本地服务支持 `--port` 参数**（默认 8765，测试用独立随机端口避免与既有实例冲突）；补充测试环境隔离说明（8765 残留实例历史坑）。

## 1. 目标

登录**可选自动化**：默认全人工（操作人员手动输入账号/密码/验证码）。启用自动化后，由本地服务
（`scripts/login-helper-server.py`，仅监听 127.0.0.1）+ 本地账号文件（`accounts.txt`，gitignore）驱动：
插件在登录页自动填写账号/密码/验证码并提交，支持多账号切换登录；登录后一键抓取（复用 app-module 批量执行器）。
**凭据不进插件 storage、不进 git/vault；页面只模拟人工操作（填表单+点按钮），不直接调平台登录 API。**

## 2. 范围

| 功能 | 说明 |
|---|---|
| 登录页检测 | 当前 URL hash 匹配 `#/pagesGrxx/pc/login*` → 判定未登录，通知 popup 显示「未登录」 |
| 登录成功检测 | hash 离开 login 且 出现用户区标志元素 → 判定已登录，通知 popup 解锁查询功能 |
| 当前账号识别 | 从页面用户区读取当前登录账号文本（脱敏处理），与模板「账号」列（C 列）匹配 |
| 会话失效检测 | 平台接口返回 401/会话过期，或页面被跳回 login 路由 → 批量任务暂停，popup 提示 |
| 自动登录 | 登录页路由 + 密码登录方式下：填账号/密码 → 读验证码图（dataURL）→ 本地服务 OCR → 填验证码 → 点「登录」→ 等待结果；**凭据来自服务器平台账号**（`GET /platform-accounts` → 选择 → `POST /platform-accounts/:id/credential` 取明文，仅 extension 会话可调） |
| 验证码识别 | 本地服务 `POST /ocr` 调 ddddocr（可选依赖）；失败/识别失败 → 刷新验证码重试 1 次 → 仍败标记待人工 |
| 多账号管理 | `accounts.txt`（gitignore）每行 `账号 密码`（首个空白分割，密码可含空格；`#` 注释行跳过）；popup 账号下拉切换登录；平台为单会话，不做并行登录 |
| 一键抓取 | 登录成功后平台默认跳 `#/pagesWsla/pc/list/index`（已确认）→ popup「一键抓取」= 对当前账号发起 START_BATCH（立案） |
| 状态持久化 | 登录状态与当前账号保存在 chrome.storage.local（仅会话信息，无凭据） |

## 3. 范围外（不做）

- 滑块/行为验证码、短信/扫码登录自动化（扫码登录不可自动，检测到扫码方式时提示人工切换密码登录）。
- 打码平台 API（超级鹰等）接入（本地服务预留 `/ocr` 接口，本期只实现 ddddocr）。
- 插件内存储账号密码（明文或加密均不存；chrome.storage 只存脱敏会话信息）。
- 直接调用平台登录 API（`POST /api/v1/login`）——只模拟人工填表点按钮，verifyId/loginType 等由页面 JS 自行处理。
- 多账号并行会话（平台单会话模型；账号切换 = 退出后重新自动登录）。
- 登录失败原因识别（不猜错误文本；停留 login 路由超时即判定失败 → 待人工）。

## 4. 选择器与判定（集中在 `extension/content/selectors.js`）

| 键 | 用途 | 当前值 |
|---|---|---|
| `route.login` | 登录页路由匹配 | `#/pagesGrxx/pc/login*`（hash 前缀匹配，已确认） |
| `login.accountInput` | 账号输入框 | `input[type=text].uni-input-input`（第 1 个 text） |
| `login.passwordInput` | 密码输入框 | `input[type=password].uni-input-input` |
| `login.captchaInput` | 验证码输入框 | `input[type=text].uni-input-input`（第 2 个 text） |
| `login.captchaImage` | 验证码图片 | 页面首个 `<img>`（src 为 `data:image/jpeg;base64,...`，已确认） |
| `login.submitButton` | 登录按钮 | 文本「登录」的 clickable view（页面无 `<button>` 标签，已确认） |
| `login.passwordTab` | 密码登录方式 tab | 文本「密码登录」（登录方式切换） |
| `header.userName` | 用户区标志（登录后出现） | `.fd-header-operate .fd-user-name`（已确认） |
| `sessionExpiredMark` | 会话失效标志 | 401/跳回 login 路由（行为判定，无固定元素） |

> 选择器均为 2026-08-03 真实会话 recon 确认；自动登录链路（填表/点按钮）待真实登录页复核（验收闸门）。

## 5. 自动登录流程（v0.2 新增，v0.3 凭据源改服务器）

```text
popup「一键登录」→ 读取服务器配置（地址/账号，chrome.storage.local 仅存非凭据配置）
→ extension 通道登录服务器（clientType=extension，取 bearer token，token 仅内存不落 storage）
→ GET /platform-accounts（admin,user 均可见启用项；只返回 id,label,enabled）
→ popup 账号下拉 = 平台账号 label 列表
→ 选中账号 → POST /platform-accounts/:id/credential（extension 会话）→ 取明文 {account,password}（仅内存）
→ content AUTO_LOGIN 消息（仅登录页路由执行）
→ 确保「密码登录」方式（必要时点 passwordTab）
→ 填账号/密码
→ 验证码：读 captchaImage.src（dataURL）→ base64 → POST http://127.0.0.1:8765/ocr（本地 OCR 不变）
→ 填验证码 → 点「登录」
→ 等待结果（≤8s）：hash 离开 login 或用户区出现 → 成功
→ 停留 login 路由 → 失败 → 点击验证码图刷新 → 重试 1 次 → 仍败 → 报「登录失败，待人工处理」
```

- 服务器不可达（登录/列表/取凭据失败）→ popup 提示服务器连接信息，不进入自动登录。
- 凭据明文只在内存流转：服务器响应 → popup → AUTO_LOGIN 消息 → content 填表，任何环节不写 storage。
- 验证码图刷新：点击 `captchaImage`（页面行为，src 更新后重新读取），不 fetch 平台 API。
- 本地服务（8765）仅用于 `/ocr` 验证码识别；`/accounts` 作为无服务器时的可选回退（默认关闭）。
- 重试全程遵守节流（间隔 3–8s）；失败标记待人工，禁止循环重试。

## 6. 本地服务契约（`scripts/login-helper-server.py`）

- 绑定 `127.0.0.1`，默认端口 `8765`（启动参数 `--port <n>` 可覆盖；测试与多实例场景用独立随机端口，避免与既有实例冲突），标准库 `http.server`，无第三方依赖（ddddocr 为可选 import）。
- CORS：`Access-Control-Allow-Origin: *` + OPTIONS 预检（content script fetch 为跨域）。
- `GET /health` → `{"ok": true}`
- `GET /accounts` → `{"ok": true, "accounts": [{"account": "...", "password": "..."}]}`
  - 读取路径：启动参数 `--accounts <path>`，默认项目根 `accounts.txt`；文件不存在 → `{"ok": true, "accounts": []}`
- `POST /ocr` body `{"image": "<base64>"}` → `{"ok": true, "text": "..."}`；ddddocr 未安装 → `{"ok": false, "error": "DDDDOCR_MISSING"}`
- 凭据只经本机回环传输；服务不写日志明文密码。

## 7. 消息流

```
content script（平台页，document_start 注入）
  → 路由变化/元素出现 → 状态变更消息
  → service worker 汇总 → chrome.storage.local 更新
  → popup 查询显示「未登录 / 已登录(账号xxx)」
popup「一键登录」→ AUTO_LOGIN {account, password, serviceUrl} → content 执行自动登录
popup「一键抓取」→ START_BATCH（列表页）→ 批量执行器（app-module）
批量任务执行器（app-module）在收到会话失效事件时暂停队列。
```

## 8. 测试

- 单测（node --test）：
  - `isLoginRoute(hash)` 前缀匹配：`#/pagesGrxx/pc/login/index` → true；`#/pagesGrxx/pc/home` → false。
  - 登录成功判定：hash 离开 login 且 userArea 存在 → true。
  - `tests/login-auto.test.js`（jsdom mock 登录页：2×text input + 1×password input + img[dataURL] + 「登录」view）：
    - `fillLoginForm` 按类型/次序填充正确；
    - `fetchCaptchaBase64` 从 dataURL img 提取 base64；
    - `doAutoLogin` 全流程（mock fetch /ocr）：成功路径、失败重试 1 次路径、服务不可达路径。
  - `tests/login-helper-server.test.js`（node 子进程 spawn python + 临时 fixture）：/health、/accounts 解析、/ocr 无 ddddocr → DDDDOCR_MISSING。
- 真实联调（验收闸门）：用户真实登录页复核自动登录链路与选择器，结果只写脱敏摘要。
- 测试环境隔离（历史坑 2026-08-05）：`withServer` 必须用独立随机端口起子进程（`--port <n>`），**不得依赖 8765 空闲**——本机曾存在未杀干净的残留服务实例（`SO_REUSEADDR` 允许多进程同端口监听），测试请求被旧实例抢答导致间歇性失败（`/accounts` 空数组、`/ocr` 错误码漂移为 OCR_FAILED）；跑测试前若怀疑残留，先 `netstat -ano | grep 8765` 清理。`stopServer` 需强杀兜底（kill 后确认退出，超时 taskkill /F）。

## 9. 验收标准

1. 未登录时 popup 显示引导提示，查询/批量按钮禁用。
2. 手动登录后 popup 自动解锁并显示脱敏账号（如 `3503****52X`）。
3. 会话失效时批量任务暂停、popup 提示。
4. 自动登录：服务在线 + accounts.txt 有账号 → 一键登录成功（真实会话复核）；失败重试 1 次后明确提示待人工。
5. 登录成功后一键抓取可在列表页启动批量查询。
6. 全程无凭据写入 chrome.storage、日志或 git；accounts.txt 在 .gitignore。
