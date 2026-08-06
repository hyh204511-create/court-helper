# M9 自动登录模块实施计划书

> 日期：2026-08-04  
> 规格基线：`docs/specs/login-module.md` v0.2（提交 `0e8559b`）  
> 勘察基线：`docs/engineering/platform-recon-2026-08-03.md`  
> 实施约束：测试先行；每个任务先看到目标测试失败，再做最小实现；每个原子任务独立提交。  
> 提交格式：`type(module): description`。

## 1. 目标

在法院平台登录页 `#/pagesGrxx/pc/login*` 提供可选的一键自动登录：popup 从仅监听 `127.0.0.1:8765` 的本地服务读取账号，content script 模拟人工选择“密码登录”、填写账号/密码/验证码并点击页面中的“登录” view。验证码图片直接从首个 JPEG data URL 图片提取 base64，交给本地 ddddocr 服务识别。登录失败只刷新验证码并重试 1 次，仍失败统一进入 `NEEDS_HUMAN`，禁止循环重试或猜测平台失败原因。

登录成功后，popup 的“一键抓取”直接复用现有 `START_BATCH` 立案批处理入口，不建立第二套查询链路。全过程不调用平台登录 API，不把账号密码写入扩展 storage、日志、git 或知识库；账号密码仅在 popup 生命周期内存和一次 `AUTO_LOGIN` 消息中短暂存在。

## 2. 当前基线与缺口

- `extension/content/login-detector.js` 已能识别登录 hash、用户区和会话失效，但登录路由尚未集中到 `SELECTORS.route.login`，且没有公开的 `isLoginRoute`。
- `extension/content/court-content.js` 目前只响应 `START_BATCH` 和 `PING`，尚无 `AUTO_LOGIN` 入口；现有 `START_BATCH`、单批 50 条和批量重试逻辑应复用，不重写。
- `extension/content/selectors.js` 只有用户区、列表和详情选择器，缺少 `route.login` 与 `login.*`。
- popup 目前只有导入、导出、开始查询；缺少本地服务状态、账号下拉、一键登录和登录态联动。
- `extension/service-worker.js` 目前使用普通 `self` message，未接入扩展 `chrome.runtime.onMessage` 和脱敏登录态持久化。
- `extension/manifest.json` 尚未授权 `http://127.0.0.1:8765/*`。
- `scripts/login-helper-server.py`、`extension/content/login-auto.js` 及其测试尚不存在。

## 3. 架构与边界

### 3.1 组件流

```text
accounts.txt（仓库根，本地私有）
  └─ 本地服务 scripts/login-helper-server.py
       ├─ GET /health
       ├─ GET /accounts
       └─ POST /ocr ← JPEG data URL 中的纯 base64
                         ↑
popup 登录区 ── AUTO_LOGIN { account, password, serviceUrl } ──→ court-content.js
  │                                                            └─ login-auto.js
  │                                                               密码 tab → 原生 setter + input
  │                                                               → OCR → 登录 view.click()
  │                                                               → 最多 2 次尝试
  ├─ 读取脱敏登录态 ← chrome.storage.local ← service-worker.js ← content 登录态事件
  └─ 一键抓取 ── START_BATCH { kind: "li" } ──→ 既有 startBatch("li")
```

### 3.2 职责划分

| 组件 | 职责 | 明确禁止 |
|---|---|---|
| `scripts/login-helper-server.py` | 回环服务、账号文件解析、ddddocr 可选调用、CORS/OPTIONS | 对外网监听；记录请求体、账号或密码；代调平台登录 API |
| `extension/content/login-auto.js` | 可单测的 DOM 操作与有界登录状态机 | storage 写入；无限重试；分析平台错误文案 |
| `extension/content/court-content.js` | 登录路由门禁、`AUTO_LOGIN` 消息接线、登录态上报、复用 `START_BATCH` | 在非登录路由执行表单动作；复制批处理实现 |
| `extension/service-worker.js` | 只持久化脱敏会话状态 | 接收或保存密码；保存原始身份证号/完整账号 |
| `extension/popup/*` | 健康检查、账号选择、操作反馈、一键登录/抓取 | 将密码放入 DOM、localStorage、chrome.storage 或日志 |

### 3.3 固定契约

- 登录页：hash 前缀 `#/pagesGrxx/pc/login`。
- 账号框：`input[type=text].uni-input-input` 集合第 1 个。
- 密码框：`input[type=password].uni-input-input`。
- 验证码框：上述 text 集合第 2 个。
- 验证码图：页面首个 `src` 以 `data:image/jpeg;base64,` 开头的 `<img>`；只取逗号后的 base64，不对法院域名发起 fetch。
- 登录触发：精确文本“登录”的可点击 view，不假设存在 `<button>`。
- 密码登录 tab：精确文本“密码登录”；需要切换时点击，并等待密码表单稳定后再填值。
- 成功条件：8 秒内 hash 离开登录路由或用户区标志出现；停留登录页不推测原因。
- 重试：最多 2 次提交。第一次失败后点击验证码图片，等待 `src` 变为新的有效 data URL，再按 3–8 秒节流进入第二次；第二次失败返回 `NEEDS_HUMAN`。
- 本地服务：`127.0.0.1:8765`、标准库 `http.server`、`Access-Control-Allow-Origin: *`、支持 OPTIONS。
- 账号文件：默认仓库根 `accounts.txt`；忽略空行和去除前导空白后以 `#` 开头的注释；每个有效行以第一个分隔空格切开，密码保留其后的空格；文件缺失返回空数组。
- OCR：`POST /ocr` 只接收 `{ "image": "<base64>" }`；成功 `{ok:true,text}`；未安装 ddddocr 时 `{ok:false,error:"DDDDOCR_MISSING"}`。
- 对外错误只使用非敏感流程码，例如 `SERVICE_UNAVAILABLE`、`FORM_NOT_READY`、`OCR_FAILED`、`LOGIN_TIMEOUT`、`NEEDS_HUMAN`；不得把账号、密码、验证码或平台响应正文拼入错误。

## 4. TDD 原子任务

每个任务均遵循：先新增/修改测试并运行到预期失败（Red）→ 只写让该任务通过的实现（Green）→ 运行任务级测试和相关回归（Refactor）→ 独立提交。下列提交命令只是实施阶段建议，本计划编写阶段不执行提交。

### 任务 1：集中登录路由与 DOM 选择器

**测试先行**

- 修改 `tests/login-detector.test.js`：新增导出 `isLoginRoute(hash)` 的前缀匹配、近似但错误路由拒绝测试；验证检测器通过集中配置判断登录页。
- 新建 `tests/login-auto.test.js`：先仅断言 `SELECTORS.login.*` 能在 jsdom 登录页定位两个 text 输入、一个 password 输入、JPEG data URL 图片，以及文本锚点。

**最小实现**

- 修改 `extension/content/selectors.js`：增加 `route.login` 及 `login.accountInput/passwordInput/captchaInput/captchaImage/submitButton/passwordTab`。对“第 1/第 2 个 text”和文本 view 采用“基础 CSS + 代码内次序/文本过滤”，不伪造不存在的 CSS 选择器。
- 修改 `extension/content/login-detector.js`：导出并复用 `isLoginRoute`，保留现有 SPA 稳定等待行为。

**验证命令**

```bash
node --test tests/login-detector.test.js
node --test tests/login-auto.test.js
```

**原子提交**：`test(login): pin login route and selector contract`，随后 `feat(login): centralize login route selectors`。

### 任务 2：实现本地服务的 health、accounts 与 CORS 契约

**测试先行**

- 新建 `tests/login-helper-server.test.js`，由 Node 子进程启动 Python 服务并在测试结束时可靠终止；账号 fixture 必须写入测试临时目录，不加入仓库。
- 覆盖 `GET /health`、不存在账号文件返回 `[]`、空行/注释过滤、首个空格拆分、密码包含空格、UTF-8 内容、未知路由，以及 OPTIONS/CORS 响应。
- 捕获服务 stdout/stderr，断言测试账号与密码均未出现。测试不得输出 fixture 正文。

**最小实现**

- 新建 `scripts/login-helper-server.py`：使用 `ThreadingHTTPServer`/`BaseHTTPRequestHandler`，只绑定 `127.0.0.1:8765`；默认账号路径从脚本位置解析到仓库根 `accounts.txt`，支持规格中的 `--accounts <path>`。
- 所有 JSON 响应统一 UTF-8、正确 Content-Type 和 CORS；覆盖 `do_OPTIONS`。覆写默认日志行为，只允许无敏感数据的启动/错误摘要。

**验证命令**

```bash
node --test tests/login-helper-server.test.js
```

**原子提交**：`test(login): define local helper account contract`，随后 `feat(login): add loopback account helper`。

### 任务 3：实现可选 ddddocr 端点

**测试先行**

- 扩展 `tests/login-helper-server.test.js`：验证合法 JSON 请求、缺失/空 image、非法 JSON 均返回稳定且不泄露正文的错误；未安装 ddddocr 时精确返回 `{ok:false,error:"DDDDOCR_MISSING"}`。
- OCR 成功路径通过测试替身注入或隔离的假模块验证 `{ok:true,text}`，不要求 CI 安装 ddddocr，也不使用真实验证码图片。

**最小实现**

- 修改 `scripts/login-helper-server.py`：ddddocr 延迟/可选 import；初始化失败与缺包统一为契约错误；识别结果仅返回 trim 后文本，不打印图片或识别内容。
- 对请求体设置合理大小上限；超限或格式错误返回 4xx，避免回环服务被异常大 payload 占用。

**验证命令**

```bash
node --test tests/login-helper-server.test.js
```

**原子提交**：`test(login): define optional ocr contract`，随后 `feat(login): add bounded local ocr endpoint`。

### 任务 4：实现登录表单纯逻辑

**测试先行**

- 扩展 `tests/login-auto.test.js`，用 jsdom 构造真实等价结构：2 个 text input、1 个 password input、JPEG data URL img、密码登录 tab 和文本“登录”的 view。
- `fillLoginForm` 测试必须监听每个字段的 `input` 事件，并用“被框架覆盖的实例 value setter”模拟 uni-app 受控输入，证明实现调用原生原型 setter，而非只做 `element.value = ...`。
- `fetchCaptchaBase64` 覆盖合法 JPEG data URL、非 JPEG、空 src、缺图；结果只包含 base64。
- 登录 view 定位覆盖：页面无 button、存在其他含“登录”的文案、只点击精确文本对应的可点击 view。

**最小实现**

- 新建 `extension/content/login-auto.js`，实现并导出 `fillLoginForm`、`fetchCaptchaBase64` 和内部可测的文本 view 定位函数。
- 字段写入统一使用 `HTMLInputElement.prototype.value` 的原生 setter，再派发 `{bubbles:true, composed:true}` 的 `input` 事件；如页面实际需要，可在真实验收后按证据补 `change`，本任务不预先猜测。
- 密码、账号、验证码不得进入异常消息或 console。

**验证命令**

```bash
node --test tests/login-auto.test.js
```

**原子提交**：`test(login): cover controlled login form inputs`，随后 `feat(login): add pure login form automation`。

### 任务 5：实现有界 `doAutoLogin` 状态机

**测试先行**

- 继续扩展 `tests/login-auto.test.js`，通过依赖注入的 `fetch`、时钟、随机节流和 location/root 测试：
  - 首次 OCR、填表、点击后登录成功；
  - `/ocr` 不可达或 `DDDDOCR_MISSING` 时停止并返回待人工，不盲目提交；
  - 首次提交超时后只点击验证码图片 1 次、等待图片 `src` 实际变化、重新 OCR，并只再提交 1 次；
  - 图片刷新异步延迟时不会重复使用旧验证码；刷新超时进入待人工；
  - 第二次仍停留登录路由时总提交次数精确为 2，结果为 `NEEDS_HUMAN`；
  - 重试间隔落在 3–8 秒边界，测试使用假等待而不真实 sleep；
  - password tab 必要时只切换一次，并等待表单出现；
  - 并发调用受到单飞保护，避免双击造成并行登录。

**最小实现**

- 修改 `extension/content/login-auto.js`：实现 `doAutoLogin`，将单次尝试、登录结果等待、验证码刷新等待拆为小函数；所有轮询都有明确 deadline。
- 重试只针对验证码/登录停留场景，总次数常量固定为 2；已知服务/OCR前置失败直接待人工，不消耗第二次平台提交。
- 成功后不主动导航，由平台 SPA 自行进入 `#/pagesWsla/pc/list/index`。

**验证命令**

```bash
node --test tests/login-auto.test.js
```

**原子提交**：`test(login): specify bounded auto login workflow`，随后 `feat(login): implement bounded auto login workflow`。

### 任务 6：接入 `AUTO_LOGIN` content 消息

**测试先行**

- 新建 `tests/content-auto-login.test.js`，在导入 `court-content.js` 前安装 jsdom 与 chrome mock，捕获注册的消息监听器。
- 覆盖：只有登录路由接受 `AUTO_LOGIN`；非登录路由返回 `NOT_LOGIN_ROUTE` 且不触碰 fetch/DOM；异步响应返回 `true`；缺少账号或密码只返回非敏感参数错误；连续消息复用单飞保护。
- 继续验证既有 `START_BATCH` 与 `PING` 分支没有被覆盖。

**最小实现**

- 修改 `extension/content/court-content.js`：导入 `doAutoLogin`，新增 `AUTO_LOGIN` 分支；路由检查必须先于参数使用和 DOM 操作。
- 捕获异常时只返回白名单流程码，不回传异常堆栈、请求体或凭据。

**验证命令**

```bash
node --test tests/content-auto-login.test.js
node --test tests/panel-login-observer.test.js
node --test tests/batch-runner.test.js
```

**原子提交**：`test(login): define auto login content message gate`，随后 `feat(login): wire auto login content message`。

### 任务 7：上报并持久化脱敏登录状态、会话失效时暂停批量

**测试先行**

- 新建 `tests/login-state.test.js`：验证 content 在 hash/用户区变化后上报 `login`、`logged-in`、`session-expired`；账号先脱敏再进入消息。
- 扩展 `tests/message-router.test.js`：验证 service worker 可接受登录态更新并只形成允许写入 storage 的 `{state, maskedAccount, updatedAt}`，消息中的额外字段（尤其 `password/account/captcha`）不会进入结果。
- 扩展 `tests/content-auto-login.test.js` 或 `tests/panel-login-observer.test.js`：运行中的批量任务遇到跳回登录路由或稳定判定为 `session-expired` 时进入暂停，不继续下一条；登录恢复后不自动提交剩余任务，必须由用户明确继续/重启。

**最小实现**

- 修改 `extension/content/login-detector.js`：增加纯函数账号脱敏，保留足够后四位或最小可辨识信息，不存完整身份证号/统一社会信用代码。
- 修改 `extension/content/court-content.js`：将登录观察提升为全页面可用的 SPA 观察器；状态变化时通过 `chrome.runtime.sendMessage` 上报；会话失效调用现有暂停机制并提示。
- 修改 `extension/shared/message-router.js` 和 `extension/service-worker.js`：接入 `chrome.runtime.onMessage`；只持久化脱敏会话字段到 `chrome.storage.local`，绝不把 `AUTO_LOGIN` payload 经过或写入 service worker。

**验证命令**

```bash
node --test tests/login-state.test.js
node --test tests/message-router.test.js
node --test tests/login-refresh.test.js
node --test tests/panel-login-observer.test.js
node --test tests/batch-runner.test.js
```

**原子提交**：`test(login): define sanitized session state flow`，随后 `feat(login): persist sanitized session state`。

### 任务 8：实现 popup 本地服务与账号区

**测试先行**

- 新建 `tests/popup-login.test.js`，对可注入 fetch/DOM/chrome tabs 的 popup 控制逻辑测试：
  - `/health` 成功后才请求 `/accounts`；服务不可达显示明确启动提示；
  - 空账号列表禁用一键登录；下拉框只呈现账号，不把密码写入 option value、dataset、title 或页面文本；
  - 密码仅保存在 popup 模块私有内存映射，关闭 popup 即释放；不调用 storage；
  - 点击一键登录只向当前法院标签发送一次 `AUTO_LOGIN`，并显示成功/待人工结果；
  - 所有 UI 错误均为固定文案，不渲染服务响应正文。

**最小实现**

- 新建 `extension/popup/login-controller.js`：封装健康检查、账号加载和消息 payload 组装，使用依赖注入保持 Node 可测。
- 修改 `extension/popup/popup.html`：增加服务健康状态、账号下拉、`#btn-auto-login` 与“一键抓取”区域；输入密码不落 DOM。
- 修改 `extension/popup/popup.css`：增加在线/离线/待人工状态样式和禁用态。
- 修改 `extension/popup/popup.js`：初始化登录控制器，读取脱敏登录态并监听 storage 变化；保留现有导入/导出/搜索行为。

**验证命令**

```bash
node --test tests/popup-login.test.js
node --test tests/import-xlsx.test.js tests/export-xlsx.test.js
```

**原子提交**：`test(login): define popup account controls`，随后 `feat(login): add popup auto login controls`。

### 任务 9：授权 loopback，并把“一键抓取”复用到 `START_BATCH`

**测试先行**

- 新建 `tests/manifest.test.js`：解析 manifest，精确断言 host permission 包含 `http://127.0.0.1:8765/*`，同时保留法院域名与 MV3 content script 配置。
- 扩展 `tests/popup-login.test.js`：已登录且位于 `#/pagesWsla/pc/list/index` 时启用“一键抓取”；点击后发送 `{type:"START_BATCH",kind:"li"}`；未登录、错误路由或服务登录仍在进行时禁用；快速双击不启动两个批次。
- 覆盖原有 `#btn-query` 的迁移策略：复用该按钮和 `handleQuery`，只调整标签/门禁，不新增第二个批处理函数。

**最小实现**

- 修改 `extension/manifest.json`：`host_permissions` 增加精确 loopback URL，不放宽到 `http://*/*` 或局域网网段。
- 修改 `extension/popup/popup.html`、`popup.js`：将现有查询按钮呈现为“一键抓取”，登录成功且列表页就绪后复用既有 `START_BATCH`。
- 如需识别当前路由，优先由 content `PING` 返回非敏感 role/route 状态；不申请超出当前范围的新权限。

**验证命令**

```bash
node --test tests/manifest.test.js
node --test tests/popup-login.test.js
node --test tests/content-auto-login.test.js
```

**原子提交**：`test(login): pin loopback and one click fetch integration`，随后 `feat(login): enable loopback login and one click fetch`。

### 任务 10：全量构建、回归与真实页面验收闸门

**自动验证**

- 先构建 bundle，确保新增 `login-auto.js`/`login-controller.js` 被现有入口正确打包。
- 运行全量 Node 24 测试，确认登录功能未破坏导入、数据库、状态识别、截图和批量执行。
- 对源文件与生成物做敏感词/危险存储审查：禁止 `chrome.storage.*.set` 接收 password、禁止记录 `AUTO_LOGIN` payload、禁止直接请求 `/api/v1/login`。

**验证命令**

```bash
npm run build
npm test
rg -n "password|AUTO_LOGIN|/api/v1/login|storage\\.(local|sync)\\.set|console\\.(log|warn|error)" extension scripts tests
```

`rg` 命中必须逐项人工判读；变量名和测试断言可以存在，凭据写 storage/日志、平台登录 API 调用不可以存在。

**真实 Edge 验收（必须人工授权并使用脱敏结果记录）**

1. 未启动本地服务：popup 显示启动 `python scripts/login-helper-server.py` 的提示，一键登录禁用。
2. 服务在线但 `accounts.txt` 缺失：账号下拉为空，插件不报崩溃、不创建示例凭据。
3. 服务在线且本地账号存在：下拉只显示账号；DevTools 的 extension storage 中无密码、验证码和完整账号。
4. 在真实登录页确认“密码登录”切换、uni-app 受控输入、验证码 data URL 读取和“登录” view 点击均生效。
5. 人为制造首次验证码失败，确认只刷新一次、等待新图后重试；第二次失败明确显示待人工且停止。
6. 登录成功后确认 SPA 到达 `#/pagesWsla/pc/list/index`，popup 显示脱敏账号，“一键抓取”调用既有立案 `START_BATCH`。
7. 查询中使会话失效，确认队列暂停、无后续自动动作，并提示人工处理。

真实验收只记录“通过/失败 + 非敏感技术摘要”；不得保存真实账号、密码、验证码、案号、当事人、页面截图或平台回执正文。

**原子提交**：如仅验证无源码变化，不提交；如仅修复构建配置，使用 `chore(login): verify auto login build`。真实联调暴露的问题必须回到对应任务补失败测试后再修复，不能直接热改。

## 5. 验收标准

1. 默认仍允许全人工登录；未主动点击一键登录时，插件不读取凭据、不操作登录表单。
2. 登录页路由和全部登录选择器集中配置，现有登录状态检测回归通过。
3. 本地服务只监听 `127.0.0.1:8765`，`/health`、`/accounts`、`/ocr` 和 OPTIONS 严格符合规格 §6。
4. `accounts.txt` 缺失时返回空数组；解析支持注释、空行和密码内空格；任何日志均无账号密码。
5. uni-app 输入框通过原生 value setter + 冒泡 input 事件更新；真实页能触发框架状态同步。
6. 验证码直接从 JPEG data URL 提取 base64；不会请求法院验证码 API，也不会把图片写盘或记录日志。
7. 登录目标为文本“登录”的 clickable view，不依赖 `<button>`。
8. 自动登录最多提交 2 次；刷新后必须等到新 `src` 再 OCR；仍失败返回 `NEEDS_HUMAN`，无循环和失败原因猜测。
9. `AUTO_LOGIN` 只在登录路由执行；错误路由、缺字段、服务不可达均安全失败且不泄露 payload。
10. popup 能显示服务健康、账号下拉、登录结果和脱敏会话状态；密码不进入 DOM/storage/日志。
11. manifest 只增加 `http://127.0.0.1:8765/*` 精确权限；在目标 Edge 环境通过 loopback 跨域实测。
12. 登录成功后列表页“一键抓取”发送现有 `{type:"START_BATCH",kind:"li"}`；没有复制批处理代码。
13. 会话失效时正在运行的批量队列暂停并提示，不把后续失败批量标成猜测状态。
14. `npm run build` 与 Node 24 下 `npm test` 全部通过；真实登录页验收闸门通过后方可宣布 M9 完成。

## 6. 主要风险与控制措施（Top 5）

| 风险 | 影响 | 控制措施/验收证据 |
|---|---|---|
| uni-app 受控输入忽略直接赋值 | DOM 看似有值，但框架提交空值或旧值 | 使用 `HTMLInputElement.prototype.value` 原生 setter + 冒泡 `input`；jsdom 受控 setter 测试与真实页提交双重验证 |
| “登录”是 clickable view 而非 button | 选择器找不到、点到“密码登录/更多用户登录”等错误目标 | 精确文本匹配并定位可点击 view；构造多个“登录”文本的测试；真实 DOM 点击验收 |
| Edge 对扩展访问 loopback 的 CORS/PNA 限制 | `/health` 或 `/ocr` 即使服务在线仍被浏览器拦截 | 精确 host permission、CORS `*`、OPTIONS；不擅自扩大网络权限；以目标 Edge 真机为发布闸门，若 PNA 仍拦截则先回规格评审 |
| 凭据通过 popup 与 content 短暂传递时泄露 | 高敏感账号/密码进入 DOM、storage、日志或错误回执 | 密码仅存 popup 私有内存；service worker 不接触 `AUTO_LOGIN`；白名单错误码；stdout/stderr 与 storage 测试；提交前定向 `rg` 审计 |
| 验证码刷新为异步，过早读取会复用旧图 | 第二次提交必然使用过期验证码，或误触无限刷新 | 保存旧 `src`，点击一次后轮询到新且合法 data URL；明确超时；假时钟测试延迟刷新；总尝试次数硬上限 2 |

## 7. 范围外

- 滑块、行为验证码、短信登录、扫码登录自动化；扫码状态只提示人工切换密码登录。
- 超级鹰等第三方打码平台；本期只支持本地可选 ddddocr。
- 直接调用法院平台 `POST /api/v1/login` 或验证码 API。
- 插件内保存账号密码（无论明文、加密或哈希）以及把凭据同步到 service worker、storage、git、知识库。
- 多账号并行会话、自动退出/切号编排；平台单会话下的切号仍由操作人员明确触发。
- 识别或推测登录失败业务原因；停留登录路由只报告待人工。
- 自动恢复会话失效后的批量队列；本期只暂停并等待用户明确处理。
- 改造既有批处理、状态映射、截图、Excel、数据库模型；一键抓取只复用 `START_BATCH`。
- 为规避 CORS/PNA 而监听 `0.0.0.0`、开放局域网访问、加入宽泛 host permissions 或引入远程中转服务。

