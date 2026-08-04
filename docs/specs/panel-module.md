# 规格：panel-module（网页浮动面板）

> 版本：0.1 ｜ 状态：待实现 ｜ 依据：用户需求（"网页上要有插件页面"，参照三客一危插件浮动面板）、app-module 操作台

## 1. 目标

在法院诉讼服务网（`https://zxfw.court.gov.cn/*`）页面右下角注入**折叠式浮动面板**：默认收起为悬浮球，点击展开完整操作面板，复用 app-module 的导入/批量查询/导出与登录状态能力。popup 保留，两者共用同一 IndexedDB 与消息链路。

## 2. 布局与交互

```
默认（收起）：右下角悬浮球（48px 圆钮，含插件图标/缩写 + 登录状态色点）
点击悬浮球 → 展开面板（420px 宽，max-height 82vh，右下角 fixed，Shadow DOM 隔离）
```

面板结构（自上而下）：

```
┌────────────────────────────────────────┐
│ 法院立案/强执查询助手    [状态点 未登录] [−]│  ← 头部：标题 + 登录状态（脱敏账号）+ 收起
│ ─────────────────────────────────────── │
│ [导入模板] [开始查询] [导出报表]          │  ← 操作区（与 popup 同功能）
│ ─────────────────────────────────────── │
│ 批量任务进度: [████████░░ 12/50]         │  ← 进度区
│ 待处理: 账号A(3条) 账号B(2条)  [暂停/继续] │
│ ─────────────────────────────────────── │
│ 登录全人工 · 未知状态标记待人工           │  ← 底部说明
└────────────────────────────────────────┘
```

- 悬浮球始终可见（`position:fixed; right:16px; bottom:16px; z-index:2147483647`）。
- 点击悬浮球展开面板；点「−」或再次点悬浮球收起；收起时面板不占用页面空间。
- 面板与悬浮球使用 Shadow DOM（`mode:"closed"`）隔离样式，宿主 `all:initial`，不受平台 CSS 污染，也不污染平台页面。

## 3. 面板内容与行为

### 3.1 登录状态
- 复用 `login-detector.js` 的 `detectLoginState` / `getCurrentAccount`：已登录显示状态点绿色 + 脱敏账号（只显示首尾，如 `a***3`）；未登录显示灰色「未登录」。
- 会话失效/过期 → 状态点红色 + 「已过期，请重新登录」，面板不阻塞（批量执行器自行暂停，见 app-module §4.3）。

### 3.2 操作区（与 popup 共用逻辑）
| 按钮 | 行为 | 复用 |
|---|---|---|
| 导入模板 | 文件选择 `.xlsx` → `importXlsx` → `db.applyImport` 写入 `cases`/`enforcementCases`，toast 展示导入摘要（新增/更新/跳过） | `data/import-xlsx.js`、`data/db.js` |
| 开始查询 | 校验登录 + 列表页就绪 → 发 `START_BATCH` 消息给当前页 content script → 展示启动结果 | `court-content.js` 现有 `startBatch` |
| 导出报表 | `buildExportWorkbook` → Blob 下载 `立案与强执查询表-<日期>.xlsx` | `data/xlsx-io.js` |

- 按钮点击后立即更新面板内进度/摘要文本；重复点击「开始查询」在任务运行中时忽略（防并发）。
- 导入/导出不请求平台，纯本地（同 app-module §3）。

### 3.3 进度区
- 监听 content script 批量执行进度：`START_BATCH` 启动后，通过 `chrome.runtime` 消息或 IndexedDB 轮询（≥3s 间隔）刷新「已完成/总数」与当前账号分组。
- 显示待处理分组：按账号聚合未完成条目（脱敏账号 + 条数）。
- 暂停/继续：发 `PAUSE_BATCH` / `RESUME_BATCH` 消息（app-module §4.3 的暂停点落盘语义不变）。
- 面板收起时不中断任务；重新展开时恢复最新进度。

### 3.4 消息协议（新增）
| type | 方向 | 载荷 | 响应 |
|---|---|---|---|
| `PANEL_SYNC` | content → panel | `{ loggedIn, account, running, done, total, groups }` | — |
| `PAUSE_BATCH` / `RESUME_BATCH` | panel → content | `{}` | `{ ok }` |

- `PANEL_SYNC` 由 content script 在状态变化时广播（或面板展开时主动拉取 `PANEL_SYNC_QUERY`）。
- 所有消息响应失败/超时 → 面板显示「采集器未就绪，请刷新页面」，不猜测状态。

## 4. 安全与脱敏
- 面板任何位置不展示完整账号、案号、当事人全名、身份证号：账号脱敏（首尾各 1 位 + `***`），案号/当事人只出现在操作结果 toast（用户主动操作触发）。
- 不自动填充登录、不存凭据（login-module 边界不变）。
- 未知状态一律显示「待人工」，禁止面板自行猜测状态词。
- 面板不修改平台请求参数、不做额外轮询（进度刷新间隔 ≥3s）。

## 5. 实现位置
- 新增 `extension/content/court-panel.js`（面板渲染/交互，纯 DOM + Shadow DOM，可测）。
- `court-content.js` 在 `document_start` 后挂载面板（同三客一危模式：`document.documentElement.appendChild(host)`，`DOMContentLoaded` 兜底）。
- esbuild 构建命令追加 `court-panel.js` 到 content bundle（`--format=iife`）。

## 6. 测试
- 单测（jsdom + fake-indexeddb）：
  - 面板挂载：宿主元素存在、Shadow DOM 内结构完整（头部/操作区/进度区/底部）。
  - 折叠交互：初始为悬浮球；点击展开；点「−」收起；再次点击恢复。
  - 登录状态渲染：未登录/已登录（脱敏断言）/过期三态。
  - 导入摘要、导出触发、开始查询消息发送（mock chrome.runtime/tabs）。
  - 进度渲染：`done/total` 与分组文本断言；`PAUSE/RESUME` 消息发送。
  - 脱敏：账号 `abcdef` → `a***f`；面板 DOM 中不出现完整账号。
- 真实联调（验收闸门）：用户已登录真实会话，展开面板 → 导入脱敏模板 → 开始查询 → 观察进度与 toast，验收记录只写脱敏摘要。

## 7. 范围外（不做）
- 不做面板内登录表单/验证码处理（登录全人工）。
- 不做面板内案件详情展示（详情在平台页，插件只采集）。
- 不做通知中心/声音提醒。
- 不常驻展开（默认收起，避免遮挡政务页面）。
