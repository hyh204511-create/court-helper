# 规格：login-module（登录状态、账号识别与自动登录）

> 版本：1.1 ｜ 状态：已确认、待实现 ｜ 依据：计划 §Phase 2、自动登录真实会话验收、Phase 11 控制台唯一入口决策
> v0.2 变更：登录全人工 → 登录自动化（可选）；新增自动登录范围、本地服务、验证码识别流程。
> v0.3 变更：**自动登录凭据来源改为服务器**（`GET /platform-accounts` 列表 + `POST /platform-accounts/:id/credential` 取明文）；验证码 OCR 仍走本地 8765 服务（ddddocr）；本地 `accounts.txt` 降级为可选回退。
> v0.4 变更：**本地服务支持 `--port` 参数**（默认 8765，测试用独立随机端口避免与既有实例冲突）；补充测试环境隔离说明（8765 残留实例历史坑）。
> v0.5 变更：**真实输入驱动**——2026-08-05 真实会话实测确认：平台（uni-app H5）**只响应 `isTrusted=true` 的真实用户事件**，JS 合成 `click()`（isTrusted=false）被静默忽略 → 自动登录「点登录按钮」「点击验证码刷新」均不触发（表单可填、提交不执行）。修复：扩展经 **`chrome.debugger` API** 向平台页注入**真实输入事件**（`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`），由 service worker 统一驱动；debugger 不可用时回退「待人工」。
> v0.8 变更：自动登录入口迁移到 `/admin/browser-control` 的“平台账号与自动登录”区域；“一键登录”创建统一 `LOGIN` 命令。删除 Popup 登录/抓取流程；独立 Options/Setup 只保留服务配置和设备配对。
> v1.0 变更：真实登录页为异步渲染。`AUTO_LOGIN` 到达登录路由后必须有界等待密码表单和验证码就绪；密码表单就绪即先填账号/密码，验证码不可用时不得阻塞这两个字段写入、不得提交，并回写既有稳定待人工码。
> v1.1 变更：统一 `LOGIN` 命令在用户已打开法院页向登录路由切换时，Service Worker 必须先有界等待路由与 content script 就绪，再交付 `AUTO_LOGIN`；不得让瞬态消息端口断开消耗命令或泄露凭据。

## 1. 目标

登录**可选自动化**：默认全人工（操作人员手动输入账号/密码/验证码）。启用自动化后，后台控制台选择服务器平台账号并创建 `LOGIN` 命令；扩展领取命令后从受控凭据出口取账号密码，本地服务（`scripts/login-helper-server.py`，仅监听 127.0.0.1）只负责 OCR，插件在登录页自动填写账号/密码/验证码并提交。登录后的查询由独立 `QUERY_LI` / `QUERY_QZ` 命令驱动。
**凭据不进插件 storage、不进 git/vault；页面只模拟人工操作（填表单+点按钮），不直接调平台登录 API。**

## 2. 范围

| 功能 | 说明 |
|---|---|
| 登录页检测 | 当前 URL hash 匹配 `#/pagesGrxx/pc/login*` → 判定未登录，回写命令/状态型浮动面板 |
| 登录成功检测 | hash 离开 login 且出现用户区标志元素 → 判定已登录，回写命令成功并更新状态 |
| 当前账号识别 | 从页面用户区读取当前登录账号文本（脱敏处理），与模板「账号」列（C 列）匹配 |
| 会话失效检测 | 平台接口返回 401/会话过期，或页面被跳回 login 路由 → 批量任务暂停，命令回写/浮动面板提示 |
| 自动登录 | 登录页路由 + 密码登录方式下：填账号/密码 → 读验证码图（dataURL）→ 本地服务 OCR → 填验证码 → **真实点击「登录」（chrome.debugger 注入 isTrusted 事件）**→ 等待结果；**凭据来自服务器平台账号**（`GET /platform-accounts` → 选择 → `POST /platform-accounts/:id/credential` 取明文，仅 extension 会话可调） |
| 验证码识别 | 本地服务 `POST /ocr` 调 ddddocr（可选依赖）；失败/识别失败 → 刷新验证码重试 1 次 → 仍败标记待人工 |
| 多账号管理 | 控制台只列出服务器启用平台账号；一次 `LOGIN` 命令绑定一个 `platformAccountId`。`accounts.txt` 只保留为本地 helper 的非默认兼容输入，不提供 UI；平台为单会话，不做并行登录 |
| 登录后查询 | 登录成功后平台默认跳 `#/pagesWsla/pc/list/index`（已确认）→ 后台另行创建 `QUERY_LI` / `QUERY_QZ`，SW 向 content 发起既有 START_BATCH |
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
后台控制台账号下拉选择启用平台账号 → 点击“一键登录”
→ POST /browser-commands 创建统一 LOGIN（payload 不含凭据）
→ 已配对 extension Bearer 的 SW 轮询并领取命令
→ POST /platform-accounts/:id/credential（extension 会话）→ 取明文 {account,password}（仅内存）
→ content AUTO_LOGIN 消息（仅登录页路由执行）
→ 有界等待并确保「密码登录」方式（必要时真实点击 passwordTab，见 §5.1）
→ 密码表单就绪即填账号/密码（不等待验证码）
→ 有界等待验证码：读 captchaImage.src（dataURL）→ base64 → POST http://127.0.0.1:8765/ocr（本地 OCR 不变）
→ 填验证码 → **真实点击「登录」**（见 §5.1 debugger 驱动）
→ 等待结果（≤8s）：hash 离开 login 或用户区出现 → 成功
→ 停留 login 路由 → 失败 → **真实点击验证码图刷新**（见 §5.1）→ 重试 1 次 → 仍败 → 报「登录失败，待人工处理」
```

### 5.1 真实输入驱动（v0.5 新增，chrome.debugger）

- **背景（真实会话实测 2026-08-05）**：平台 uni-app H5 只响应 `isTrusted=true` 的真实用户事件；`Element.click()` 合成事件（isTrusted=false）被平台静默忽略——表单可填（v-model 响应 input 事件）但「登录」「刷新验证码」点击均不触发。
- **机制**：content script 无法产生 trusted 事件 → 由 **service worker 经 `chrome.debugger`** 向平台页注入真实输入：
  1. content 计算目标元素中心坐标（`getBoundingClientRect`，CSS 像素），随 `CLICK_REQUEST {x, y}` 消息发给 SW；content 不携带 `tabId`，SW 从 `sender.tab.id` 获取；
  2. SW 若未 attach 该 tab 则 `chrome.debugger.attach({tabId}, "1.3")`（attach 一次，自动登录结束 detach）；
  3. `chrome.debugger.sendCommand({tabId}, "Input.dispatchMouseEvent", {type: "mousePressed", x, y, button: "left", clickCount: 1})` + `mouseReleased`（真实事件，isTrusted=true）；
  4. 回执 `{ok}` → content 继续流程。
- **适用范围**：「登录按钮」「验证码刷新」「passwordTab 切换」必须真实点击；填表仍用 content 内 input 事件（已实测有效）。passwordTab 仅在当前页面尚非密码登录模式时发送 `CLICK_REQUEST`，已是密码模式时跳过。
- **键盘替代**：密码框 `Input.dispatchKeyEvent`（Enter）可作登录按钮点击的补充尝试，但**不替代**按钮真实点击（uni-app 对 Enter 提交无保证）。
- **权限**：manifest 新增 `"debugger"` 权限；`chrome.debugger` 仅用于法院平台 tab，自动登录结束即 detach（不留驻）。
- **失败回退**：`attach` 失败 / sendCommand 报错 / 无 tab → 返回「待人工」（提示用户手动操作），**不做**合成点击兜底（对平台无效且掩盖问题）。
- **坐标注意**：页面有缩放（devicePixelRatio≠1）时 getBoundingClientRect 已是 CSS 像素，CDP Input 坐标同用 CSS 像素，无需换算（已实测一致）。

- 服务器不可达（轮询/领取/取凭据失败）→ 命令保持稳定失败/待人工状态，不进入自动登录。
- 凭据明文只在内存流转：服务器响应 → SW → AUTO_LOGIN 消息 → content 填表，任何环节不写 storage。
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
  → service worker 汇总 → chrome.storage.local 更新 → 状态型浮动面板显示脱敏状态
后台“一键登录”→ LOGIN command → SW 取凭据 → AUTO_LOGIN {account, password, serviceUrl} → content 执行自动登录
content 需真实点击（登录按钮/验证码刷新/passwordTab 切换）→ CLICK_REQUEST {x, y} → SW 从 sender.tab.id 获取 tab → 经 chrome.debugger 注入 → 回执
后台 QUERY command → START_BATCH（列表页）→ 批量执行器（app-module）
批量任务执行器（app-module）在收到会话失效事件时暂停队列。
```

## 8. 测试

- 单测（node --test）：
  - `isLoginRoute(hash)` 前缀匹配：`#/pagesGrxx/pc/login/index` → true；`#/pagesGrxx/pc/home` → false。
  - 登录成功判定：hash 离开 login 且 userArea 存在 → true。
  - `tests/login-auto.test.js`（jsdom mock 登录页：2×text input + 1×password input + img[dataURL] + 「登录」view）：
    - `fillLoginForm` 按类型/次序填充正确；
    - `fetchCaptchaBase64` 从 dataURL img 提取 base64；
  - `doAutoLogin` 全流程（mock fetch /ocr + mock CLICK_REQUEST）：成功路径、失败重试 1 次路径、服务不可达路径。
  - 登录页异步渲染：初始无密码表单或验证码、在有界等待内出现后继续；验证码仍未就绪时账号/密码已填入且不提交。
  - **v0.5 新增** `tests/debugger-driver.test.js`（mock chrome.debugger）：attach/detach 生命周期（登录结束必 detach）、mousePressed+mouseReleased 双命令顺序、坐标透传、attach 失败 → 回执「待人工」、非法院 tab 拒绝 attach。
  - content 端坐标计算单测：`getBoundingClientRect` 中心点取整、元素不可见/无 rect → `FORM_NOT_READY`。
  - `tests/login-helper-server.test.js`（node 子进程 spawn python + 临时 fixture）：/health、/accounts 解析、/ocr 无 ddddocr → DDDDOCR_MISSING。
- 真实联调（验收闸门）：用户真实登录页复核自动登录链路与选择器，结果只写脱敏摘要。
- 测试环境隔离（历史坑 2026-08-05）：`withServer` 必须用独立随机端口起子进程（`--port <n>`），**不得依赖 8765 空闲**——本机曾存在未杀干净的残留服务实例（`SO_REUSEADDR` 允许多进程同端口监听），测试请求被旧实例抢答导致间歇性失败（`/accounts` 空数组、`/ocr` 错误码漂移为 OCR_FAILED）；跑测试前若怀疑残留，先 `netstat -ano | grep 8765` 清理。`stopServer` 需强杀兜底（kill 后确认退出，超时 taskkill /F）。

## 9. 验收标准

1. 未登录时控制台命令状态/浮动面板明确提示人工登录或可用的一键登录，不伪造已登录。
2. 手动登录后状态链路显示脱敏平台账号（如 `3503****52X`）。
3. 会话失效时批量任务暂停，命令回写和浮动面板提示。
4. 自动登录：服务在线 + 服务器平台账号有凭据 → 控制台一键登录创建 LOGIN 并成功执行（真实会话复核）；失败重试 1 次后明确提示待人工。
5. 登录成功后 QUERY_LI/QUERY_QZ 可在合规列表页启动批量查询。
6. 全程无凭据写入 chrome.storage、日志或 git；accounts.txt 在 .gitignore。
7. （v0.5）真实会话：自动登录的「点登录」「刷新验证码」由 chrome.debugger 注入真实事件（isTrusted=true）触发；扩展结束自动登录后 debugger 已 detach（扩展管理页无「正在调试」残留提示）。

## 10. 本机 OCR 助手绑定后台服务生命周期（v0.9）

- `scripts/start-server.ps1` 为本机启动唯一入口，并显式启用 `LOCAL_LOGIN_HELPER_AUTOSTART`。
- 后台完成迁移并开始监听 `127.0.0.1:3000` 后，立即异步确保本机 `127.0.0.1:8765` OCR 助手可用，且不等待健康探测或 Python 启动完成；不再依赖首次 `admin_ui` 登录。已健康的外部实例不重复启动，未运行时只启动固定脚本 `scripts/login-helper-server.py --ocr-only`。
- OCR 启动失败不得阻断后台监听或暴露进程细节、环境变量、账号或密码；扩展仍按既有 `SERVICE_UNAVAILABLE` / `NEEDS_HUMAN` 路径降级。
- 后台关闭时，仅停止本后台进程自行启动的 OCR 子进程；健康检查发现的外部实例不得被停止。后续成功的 `admin_ui` 登录只作幂等健康兜底，不改变该生命周期归属。

## 11. 后台绑定的扩展授权（v0.7）

- 管理员成功登录后台后，OCR helper 的按需启动保持不变；扩展服务器身份改为管理员显式批准的一次性设备配对，不再由扩展页面提交服务器用户名或密码。
- 扩展生成 `deviceId` 与高熵 `exchangeSecret`，从配置的 extension Origin 发起 pending pairing；管理员仅在 `/admin/browser-control` 对核对码批准。兑换后的 30 天 opaque Bearer session 绑定设备，仅保存在 `chrome.storage.local`，并可由后台撤销。
- 管理员创建的 extension session 可执行业务操作，但不能管理用户：`/users*` 必须要求 `admin_ui` Cookie、管理员角色、受信 Origin 与 CSRF。extension Origin 不构成认证，也不得换取 Cookie。
- 独立 Options/Setup 页面提供“后台服务器地址”配置，不提供服务器用户名、密码或 token 输入。当前本机验收只接受 `http://127.0.0.1:3000`；点击“请求后台授权”时由 SW 原子保存规范化地址并创建一次配对。空地址、凭据、query、fragment 或非根路径均不得发起请求。
- 地址变更必须清除旧设备 token、待兑换 pairing 和设备标识，再按新地址重新经管理员批准；保存地址本身不得自动新建 pairing，避免与用户点击请求产生并发重复。
- 地址切换必须使旧地址的在途创建/兑换响应失效，禁止旧 token 或 pairing 在新地址配置后回写；Options/Setup 查询授权状态时必须从持久化设备状态恢复，不能依赖 MV3 Service Worker 尚未休眠。
- Popup 必须删除；Options/Setup 只保留授权状态和降级提示，不得展示或传递服务器密码，也不得承载登录、导入、查询或导出按钮。

## 12. 云端生产地址（v1.2）

- 正式交付包的配对地址由非敏感发布配置固定为 `https://court.hyhbrand.xyz`；只接受 HTTPS 精确根 Origin，禁止凭据、路径、query、fragment、其他端口与通配地址。
- 开发构建可继续使用 `http://127.0.0.1:3000`，但生产 Manifest 不得保留该 host permission。
- 本地 OCR 始终为 `http://127.0.0.1:8765`，云端后台不得尝试启动客户电脑的 OCR 进程。
