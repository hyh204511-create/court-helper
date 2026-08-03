# 平台技术侦察记录（2026-08-03）

> 目的：真实联调第一阶段——未登录状态下对人民法院在线服务网（zxfw.court.gov.cn）做只读侦察，为 login/query 模块选择器与 API 契约提供事实依据。
> 方法：浏览器访问 + 静态 JS 包分析（`/zxfw/static/js/index.a418ba12.js` 851KB、chunk-vendors 961KB）。
> 性质：全部为技术结构信息，无任何业务明文。**登录后页面结构未验证**（无登录会话）。

## 1. 登录页（`#/pagesGrxx/pc/login/index`）— 已确认

**真实 DOM（2026-08-03 用户真实 Chrome + CDP 实测，非远程浏览器）：**

- 框架：uni-app（PC 版），输入框 class `uni-input-input`；按钮为 view 元素（无 `<button>` 标签）。
- 账号输入框：`input[type=text].uni-input-input`（第 1 个）
- 密码输入框：`input[type=password].uni-input-input`
- 验证码输入框：`input[type=text].uni-input-input`（第 2 个 text）
- 验证码图片：页面内首个 `<img>`（`data:image/jpeg;base64,...`，页面加载时由接口生成）
- 登录按钮：文本「登录」的 clickable view；用户类型 tab（个人用户/律师用户/法人用户）；登录方式（扫码登录/密码登录）
- 页面文本锚点（用于断言）：人民法院在线服务网 / 个人用户 / 律师用户 / 法人用户 / 扫码登录 / 密码登录 / 请输入手机号/居民身份证号 / 请输入登录密码 / 请输入验证码 / 登录 / 立即注册 / 忘记密码 / 更多用户登录

无障碍树快照（等价结构）：

```
人民法院在线服务网
[个人用户] [律师用户] [法人用户]          ← 用户类型 tab
[扫码登录] [密码登录]                    ← 登录方式切换
输入框: 手机号/居民身份证号
输入框: 登录密码
输入框: 验证码
<img 验证码图片>
[登录] 按钮
[立即注册] [忘记密码]
更多用户登录: [法官] [鉴定机构] [破产管理人]
```

- 用户类型 tab 对应 loginType（个人/律师/法人）；模板账号列同时含身份证号（个人）与统一社会信用代码（法人）。
- 登录流程：验证码图片 → 人工识别输入 → 提交 `POST /api/v1/login`（字段 `loginType/username/password/verifyId/code`）。
- **连接方式（本项目联调标准）**：本机 Chrome 以 `--remote-debugging-port=9222 --user-data-dir="C:\Users\28368\AppData\Local\Google\Chrome\User Data"` 启动（Chrome 136+ 必须显式 user-data-dir），用 `scripts/cdp-probe.py` 控制（tabs/dump/open/nav）。已写入 Hermes 全局配置 `browser.cdp_url=http://127.0.0.1:9222`、`browser.allow_private_urls=true`（新会话生效）。注意本机代理 fake-ip（198.18.x.x）会被 browser 工具判为私网，CDP 直连不受影响。

## 2. 登录/认证 API（静态分析确认）

| 端点 | 用途 |
|---|---|
| `POST /api/v1/login` | 密码登录；表单字段含 `loginType/username/password/verifyId/code`（verifyId=图形验证码 ID，code=验证码输入） |
| `GET /api/v1/cl/code` | 图形验证码图片 |
| `POST /api/v1/sms/captcha`、`/api/v1/sms/login` | 短信验证码/短信登录（备选） |
| `/api/v1/oauth/code`、`/api/v1/oauth/code/fg` | OAuth 登录码 |
| `/api/v1/alipay/*` | 支付宝扫码/认证登录 |
| 存储键 | `uni.getStorageSync("verify")`、`"loginType"`；loginType 示例值 `pcglr`（破产管理人） |

## 3. 案件数据 API（静态分析确认）

| 端点 | 用途 |
|---|---|
| `/api/v1/aj/list` | 案件列表 |
| `/api/v1/aj/detail` | 案件详情 |
| `/api/v1/ajListByUserId` | 按用户列案件 |
| `/api/v1/ajxx`、`/api/v1/ajxq`、`/api/v1/ajzyList`、`/api/v1/aj/checkAh` | 案件信息/详情/卷宗/案号校验（候选） |

> 说明：插件主链路仍按规格走 **DOM 采集 + 截图**（用户表格需要的是页面凭证截图，不是接口数据）；API 清单用于登录检测与后续只读校验，不作为采集主路径。

## 4. 路由家族（静态分析确认）

- `pagesGrxx/`：个人中心（pc/login、pc/personal-info/index、pc/jbxx、pc/lssfrz/* 律师认证、pc/oauth/*、pc/frzcsq、pc/rlsb、pc/zcxy、app/personal-info/* 个人信息子页、app/regist/* 注册）
- `pagesAjkj/`：案件模块（common/case-space 案件空间、common/wssd 文书送达、common/zxjf 在线缴费、common/zxts 在线庭审、common/zjjh 证据交换、common/wtjd 问题解答、app/sddzqrs 送达地址确认等）
- `pagesOther/`、`pagesCustom/`：其他/定制页
- 入口 hash：`#/pagesGrxx/pc/login/index`（登录）；登录后首页入口 **未验证**

## 5. 「我的立案审判 / 查看强执」模块定位 — 已确认（2026-08-03 用户真实登录会话）

- **查询页 =「网上立案」列表**：登录后默认路由 `#/pagesWsla/pc/list/index`（标题「网上立案」）。用户口语「我的立案审判」= 本页立案列表；「查看强执」= 本页顶部 tab 选「执行」。
- 页面结构（uni-app / uni-view 组件）：
  - 顶栏 `.fd-com-header > .fd-pc-first-header`：`.fd-title-container`（标题）+ `.fd-header-operate`（用户区）
  - **用户区（userAccount 候选，已确认）**：`.fd-header-operate .fd-user-name`（uni-text，当前登录账号名）；旁有 `.fd-select-area`（省份 uni-picker）、`.fd-persional-info`（个人信息）、`.fd-file-info`、`.fd-exit`（退出）
  - 主容器 `.fd-com-main-container.fd-com-tab-bg`：
    - `.fd-com-tab`：顶部案件类型 tab（调解/保全/**审判**/**执行**/破产/信访），内部为 `segmented-control`；切换为纯前端状态（URL 不变）
    - `.fd-com-search`：搜索区（案件名称输入 + `.fd-com-search-btn` 查询按钮；筛选：进展阶段/时间筛选/申请身份/省份，均为「全部」下拉）；**切换 tab 或进入页面后需点「查询」才加载列表**
    - `.fd-com-list-container`：案件列表容器（空态文案「暂无数据」）
    - `.fd-com-pagination-container`：分页（共 N 条 / 上一页 / 页码 / 下一页）
  - 底部 `uni-tabbar`：首页/服务/日程/消息/我的
  - 服务指引区：在线立案 / 我的立案 / 我的案件 / 文书送达 / 在线交费 / 在线阅卷 / 诉讼工具 / 文书制作 / 其他服务（文字入口，非跳转按钮）
- 登录后顶栏文本锚点：`[省份] | [姓名] | 适老服务 | 用户须知`（省份=fd-select-area，姓名=fd-user-name）。

### 5.1 案件列表行结构（已确认，真实案件实测）

```
.fd-case-item                          ← 案件卡片
├── .fd-card-header                    ← 点击进详情（on:click → getDetail(a)）
│   ├── .fd-header-status.fd-status-{css}   ← 状态：文本 + 样式类（warning/success/error/primary）
│   ├── .fd-header-ajmc                 ← 案件名称（如 [A]诉[B]买卖合同纠纷一案）
│   └── .fd-header-ajlx                 ← 案件类型（如 民事一审案件）
├── .fd-card-content
│   ├── .fd-case-field
│   │   └── .fd-field-item × N          ← 字段行（.fd-field-lable + .fd-field-value）
│   │       立案列表字段（实测）：参与人(原告/被告)、案由、申请日期、法院、审核意见
│   └── .fd-case-space-btn              ← 「案件空间」按钮 → 新标签打开详情页
└── .fd-card-option
    └── .fd-option-btn × M              ← 操作按钮（评价/补充材料/复制立案/删除…，按状态显示）
```

- 状态文本在 `.fd-header-status`（文本 + `fd-status-warning/success/error/primary` class 双通道）。
- **审核意见（驳回原因）在列表行直接可见**（`.fd-field-item` 中 label=审核意见），不必进详情。
- 详情入口：`.fd-card-header` 点击（getDetail 按状态分流）；「案件空间」按钮稳定打开新标签详情页（路由 `#/pagesWsla/common/wsla/detail/index?layyid=<id>&ajlx=...&fyid=...`）。

### 5.2 案件详情页结构（已确认，待补充材料案件实测）

路由：`#/pagesWsla/common/wsla/detail/index?layyid=<id>&ajlx=<类型>&fyid=<法院id>&ajmc=<案件名>`，标题「案件空间 | 案件名称」。

- **审核结果区**（驳回/待补充材料案件）：
  - 审核结果：文本（实测「退回补充材料」；字典 css warning）
  - 审核时间：`2026-07-28 15:09:30`（**含时分秒，写入表格取日期部分**）
  - 是否调解：否
  - 审核意见：驳回原因全文（实测与列表行一致）
- 基本信息：立案法院 / 案件类型 / 立案案由 / 标的金额(元)
- 原告信息 / 被告信息（姓名/证件号码/电话/住址等——**真实个人信息，采集时只取业务所需字段，不落盘明文**）
- 第三人信息 / 代理人信息 / 材料信息 / 起诉状
- 字段映射（模板列）：审核时间 → 驳回时间（I 列，取 YYYY-MM-DD）；审核意见 → 驳回原因（J 列）；审核结果文本 → 状态词（退回补充材料/待补充材料 → 已驳回）

### 5.3 状态码字典（静态分析确认，zt 字段）

| 码值 | 文本 | css | 映射到模板状态词 |
|---|---|---|---|
| 11800007-1 | 待审核 | warning | 审核中 |
| 11800007-2 | 审核通过 | success | UNKNOWN（待人工确认） |
| 11800007-3 | 审核不通过 | error | 已驳回 |
| 11800007-4 | 已立案 | success | 立案成功 / 强执成功 |
| 11800007-5 | 不予立案 | error | 已驳回 |
| 11800007-6 | 待补充材料 | warning | 已驳回 |
| 11800007-31 | 待补正 | primary | 已驳回 |
| 11800007-100 | 待提交 | primary | UNKNOWN（待人工） |
| 11800007-101 | 申请失效 | primary | UNKNOWN（待人工） |
| 11800007-255 | 撤回中 | primary | UNKNOWN（待人工） |
| 11800007-500 | 提交失败 | error | UNKNOWN（待人工） |

- 列表行状态文本 = `ztMap[a.zt].text`；css 类 = `fd-status-{css}`（与字典一致）。
- 详情「审核结果」文本可能与列表状态文本不同（实测列表=待补充材料，详情=退回补充材料）→ **采集器以列表行状态为主，详情文本仅用于确认**。

### 5.4 「我的案件」页面（`#/pages/pc/case-list/index`）— 已确认（用户工作流核心页）

标题「我的案件」；结构同网上立案页（`.fd-com-main-container.fd-com-tab-bg` → `.fd-com-tab` + `.fd-com-container`）。

- 顶部 tab：调解/保全/**审判**/**执行**/破产/信访（DOM click 生效；切换后需点「查询」加载）
- 搜索：案号、案件名称、法院查询；筛选：案件状态/排序/省份
- **列表行（同 fd-case-item 结构）**：
  - `.fd-header-status.fd-status-1`：案件状态文本（立案成功账号实测「审理中」；**注意此页状态码 css 是 fd-status-1 数字类，与网上立案页的 fd-status-warning 命名不同** → 采集器以文本识别为主，class 仅辅助）
  - `.fd-header-ajmc` 案件名称（[A]与[B]买卖合同纠纷一案）；`.fd-header-ajlx` 案件类型（民事案件）
  - `.fd-field-item` × 5：**案号** / **立案日期** / 开庭时间 / 生效时间 / 法院（立案案件实测：案号=（2026）京…民初…号、立案日期=YYYY-MM-DD，与模板 F/G 列一致）
  - `.fd-case-space-btn` 案件空间；`.fd-card-option` 按钮（在线阅卷等）
  - 「手动同步案件」按钮（列表上方）
- **强执查询**：顶部「执行」tab → 执行案件列表（同布局；当前实测账号无执行案件 → 暂无数据；**执行案件的行字段（强执案号/执行法院等）待强执账号登录后确认**）
- 用户工作流对应：**「我的立案审判」= 本页立案列表（案号+立案日期在此读取）；「查看强执」= 顶部「执行」tab**

### 5.5 已立案案件详情页（案件空间，已确认）

- 审核结果区为**记录列表（按时间倒序）**：最新一条「已立案」+ 审核时间（= **立案成功时间**，含时分秒，写表格取日期）；前一条「审查通过」+ 审核时间；审核意见「决定立案」
- 基本信息：立案法院/案件类型/立案案由/标的金额
- 当事人信息区（原告/被告，含证件号码等——**真实个人信息，采集只取业务字段**）
- **案号/立案日期不在详情页，在「我的案件」列表行**（5.4）——用户「点击左侧案件查看立案成功时间及案号」即指此页

### 5.6 强执案件（已确认，真实执行案件实测）

- **网上立案页（pagesWsla/pc/list）+ 执行案件**：类型「首次执行案件」；参与人「申请执行人/被执行人」；状态「已立案」（→ 强执成功）；申请日期；审核意见「决定立案」。
- **强执详情页（案件空间）**：
  - 审核结果区：「已立案」+ 审核时间 `2026-06-03 00:00:00`（= **强执成功时间**，与模板 F 列一致）
  - 基本信息：立案法院 / 案件类型（首次执行案件）/ 执行依据类别（民商）/ 原审案号（民事原审案号，非强执案号）
  - 申请执行人信息 / 被执行人信息（真实个人信息，只取业务字段）/ 执行标的信息 / 代理人信息
- **「我的案件」页 + 「执行」tab**（强执案号数据源）：
  - 列表行同 fd-case-item 结构：状态「已结案」（执行案件终态）+ 案件名（[A]申请[B]买卖合同纠纷）+ 类型「执行类案件」
  - `.fd-field-item` × 5：**案号（=（2026）京…执…号，强执案号）** / **立案日期（=强执成功时间）** / 开庭时间 / 生效时间 / 法院
  - 按钮：案件空间 / 事项申请
- **模板状态映射（强执）**：网上立案页「已立案」→ 强执成功；「我的案件」页「已结案」→ 强执成功；「待审核/待补充材料/驳回」→ 审核中/已驳回（同立案规则）。

### 5.7 用户工作流与页面数据源对照（最终版）

| 用户动作 | 页面 | 数据 |
|---|---|---|
| 「我的立案审判」查询 | 网上立案页（状态/审核意见）→ 案件空间详情（审核时间） | 待审核→审核中；待补充材料/驳回→已驳回（驳回时间=详情审核时间，原因=审核意见） |
| 立案成功取证 | 「我的案件」页列表行 | 案号 + 立案日期（=立案成功时间）→ F/G 列 + 成功图片 |
| 「查看强执」= 顶部「执行」tab | 网上立案页「已立案」→ 强执成功；「我的案件」页「已结案」→ 强执成功 | 强执案号 + 强执成功时间（=立案日期/详情审核时间）→ 强执表 F/G 列 + 成功图片 |
| 截图时机 | 对应状态页面稳定后 captureVisibleTab | 成功页截 H 列图；驳回页（详情）截 K 列图 |

## 6. 未验证清单（剩余阻塞项）

| 项 | 状态 |
|---|---|
| 会话失效表现（401 跳转/提示文案） | 未验证（实现后由真实验收覆盖） |
| 网上立案页列表行/详情页（待补充材料） | ✅ 已确认（5.1/5.2） |
| 「我的案件」页列表行（已立案/审理中） | ✅ 已确认（5.4/5.5） |
| 强执（网上立案+我的案件+详情） | ✅ 已确认（5.6） |
| 状态字典 11800007（网上立案 zt） | ✅ 已确认（5.3） |
| **全部核心页面结构** | ✅ **已确认（2026-08-03 三个真实账号实测）** |

## 7. 风险提示

- 本次访问环境无住宅代理，平台侧 bot 检测可能更激进；批量动作必须保持节流（3–8s）与低频率。
- 登录尝试不做（无凭据 + 全人工边界）；侦察全部为 GET 静态资源与页面内交互。
