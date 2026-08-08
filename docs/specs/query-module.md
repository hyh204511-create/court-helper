# 规格：query-module（立案/强执采集与状态识别）

## 主世界结构化接口桥（真实验收修订）

- 真实页面验收确认：隔离世界中的 content script 直接 `fetch` 会得到 401；MAIN world 原生 `fetch` 仍不会经过法院页面请求适配器，因缺少页面适配器注入的鉴权头同样得到 401。结构化接口请求必须由 content script 发送内部消息，经 service worker 调用 `chrome.scripting.executeScript`，并显式指定 `world: "MAIN"`，在已登录的法院标签页主世界调用页面已经加载的请求适配器。插件只向适配器传受控 path/method/body，不读取、复制、返回或持久化鉴权值。
- service worker 只允许已确认的法院接口路径：`/yzw/yzw-zxfw-lafw/api/v3/layy`、`/layy/count`、`/layy/layyxq/{layyid}/0`、`/pz/layymb/{fyid}/{ajlx}`，以及 `/yzw/yzw-zxfw-ajfw/api/v1/ajlist`。禁止任意 URL、跨域 URL、路径穿越和未确认接口。
- 方法白名单：lafw 列表、总数、详情和模板仅允许 `GET`；`layy` 与 `layy/count` 的 `ajlb` 只允许立案 `sp` 或强执 `zx`；ajfw `ajlist` 仅允许 `POST`。主世界原生探测请求必须使用 `credentials: "include"` 和 `redirect: "manual"`；遇到 401/403 时只允许改走页面自身已加载的受控请求适配器，不得接收或拼接 Cookie、Token、Authorization 等凭据参数。受限 query 键不得重复；详情/模板路径不得带 query；路径参数只接受受限字符且拒绝编码后的斜杠、反斜杠与点段。3xx/opaque redirect 必须在跟随前转 `LOGIN_REDIRECT`，避免 POST body 被转发。
- sender 必须来自已确认的 `zxfw.court.gov.cn` 法院标签页；缺少 tab、来源 host 不符或非 http(s) 页面均拒绝执行。
- 401、403、登录重定向、非 JSON、网络异常必须映射为稳定的待人工结果，禁止回退 DOM 猜测或把失败包装成空成功。
- 桥返回只包含业务 JSON、HTTP 状态和稳定错误码；响应对象及日志不得包含 Cookie、Token、Authorization 或其他请求凭据。
- content 查询链路必须调用该白名单桥获取结构化数据；插件 DOM 仅用于真实页面定位、双向唯一匹配和截图。

> 版本：0.2 ｜ 状态：待实现 ｜ 依据：计划 §2.2/2.3、用户需求原文、模板状态词（已确认）、一键查询并导出决策

## 1. 目标

在用户已登录的平台页上，采集「我的立案审判」/「查看强执」中的案件状态、时间、案号、驳回原因，触发截图，并输出结构化记录供 excel-module 落库。空白报表模板触发“平台发现模式”：以当前可见真实列表为输入，不以模板行充当案件事实；非空表块不进入查询。

## 2. 状态映射表（唯一权威，禁止猜测）

平台显示文本 → 模板状态词 → 附加动作（**2026-08-03 三个真实账号联调确认**）：

| 场景 | 平台文本 | 状态词（写入表格） | 详情动作 |
|---|---|---|---|
| 立案（网上立案页） | 待审核 | 审核中 | 不进入详情；记录当天查询时间（L 列） |
| 立案（网上立案页） | 已立案 / 审核通过 | 立案成功 | 截图→成功图片(H)；「我的案件」页列表行取案号(G) + 立案日期(F) |
| 立案（我的案件页） | 审理中 | 立案成功 | 同上（有案号+立案日期=已成功立案） |
| 立案（我的案件页） | 已结案 | 立案成功 | 同上（民事类） |
| 立案（网上立案页） | 待补充材料 / 审核不通过 / 不予立案 / 待补正 | 已驳回 | 进详情取审核时间(I，取日期) + 审核意见(J)，截图→驳回图片(K) |
| 强执（网上立案页） | 已立案 / 审核通过 | 强执成功 | 截图→成功图片(H)；「我的案件」页执行 tab 取强执案号(G) + 强执成功时间(F=立案日期) |
| 强执（我的案件页） | 已结案 | 强执成功 | 同上（执行类案件） |
| 强执（网上立案页） | 待审核 / 待补充材料 / 审核不通过 / 不予立案 / 待补正 | 审核中 / 已驳回 | 同立案规则 |
| 任意 | 其他/未知文本 | UNKNOWN | 标记待人工，禁止猜测，不写入任何状态词 |

- 状态识别只认**精确文本匹配**（去空白后全等）；识别器 `status-recognizer.js`（纯函数，双页面映射）。
- 一条记录同时出现多个可识别状态（如列表行「已立案」但详情显示异常）→ 以详情页为准，冲突时标 UNKNOWN 待人工。
- 案件类型含「执行」（首次执行案件/执行类案件/恢复执行）→ 强执场景。
- 状态码字典（网上立案页 zt 字段，静态分析）：11800007-1 待审核 / -2 审核通过 / -3 审核不通过 / -4 已立案 / -5 不予立案 / -6 待补充材料 / -31 待补正 / -100 待提交(UNKNOWN) / -101 申请失效(UNKNOWN) / -255 撤回中(UNKNOWN) / -500 提交失败(UNKNOWN)。`审核通过` 仅接受该精确可见文本：审判类映射为立案成功，执行类映射为强执成功，不接受近似文本。

## 3. 采集器（`extension/content/case-collectors.js`，纯函数 + 选择器配置）

### 3.1 列表采集器（collectListRows / collectRow / collectFields）
- 适用页面：网上立案页（`#/pagesWsla/pc/list/index`）与「我的案件」页（`#/pages/pc/case-list/index`）共用 `.fd-case-item` 行结构。
- 输出：`{ statusText, caseName, caseType, fields: [{label, value}], hasSpaceBtn }`。
- 纯采集输出不得混入 DOM 节点；需要点击详情或截图的调用链必须在同一次列表快照中按索引保留 `{data, element}` 配对，并只把真实且仍连接页面的 `element` 交给动作函数，禁止把结构化 `data` 对象当 DOM 使用。
- 字段行 `.fd-field-item > (.fd-field-lable + .fd-field-value)`；`findField(fields, label)` 按 label 取 value；`extractBusinessFields` 提取案号/立案日期/法院/审核意见/申请日期。
- 数据源分工：网上立案页字段含申请日期/审核意见（驳回取证）；「我的案件」页字段含**案号/立案日期**（成功取证，立案与强执同构）。

### 3.2 详情页采集器（collectDetail）
- 适用页面：案件空间（`#/pagesWsla/common/wsla/detail/index`）。
- 表单项 `.uni-forms-item` 的 innerText 为「label\nvalue」结构；「审核结果」+「审核时间」+「审核意见」必须归入同一条 `{status,time,opinion}` 审核记录。不得只依赖 DOM 顺序：按可比较的 `审核时间` 选取日期最新的一条，写表格取日期，并只截取该最新审核结果区域。最新记录缺少时间或意见时返回 `AUDIT_EVIDENCE_INCOMPLETE + needsHuman=true`，不得回退到更早的完整记录，也不得把历史意见与最新时间拼接。
- 输出：`{ auditRecords: [{status, time, opinion}], fields: {label: value}, opinion }`；顶层 `opinion` 仅为最新记录意见的兼容别名。最新记录缺少意见时必须为 `null`，禁止回退到下一条历史记录的意见。
- 强执详情字段：案件类型（首次执行案件）/执行依据类别/原审案号（原审案号≠强执案号，强执案号在「我的案件」页执行 tab 列表行）。

### 3.3 强执查询采集
- 入口：「我的案件」页顶部「执行」tab（`.fd-com-tab` 内文本「执行」，DOM click 生效）→ 点「查询」（`.fd-com-search-btn`）加载列表 → 行结构同 3.1，案号/立案日期即强执案号/强执成功时间。

### 3.4 导航与节流（写动作控制）
- 允许的写动作：进入详情（`.fd-card-header` 点击 / 「案件空间」按钮 `.fd-case-space-btn` 打开新标签）、点击左侧案件、切换 tab（顶部类型 tab）、点「查询」、返回列表。仅限 query-module 采集所需。
- 每个动作前确认目标元素可见可点；点击后等待页面稳定（等待标志元素出现，超时 10s → 失败重试 1 次 → 标记待人工）。
- 批量任务相邻案件间隔 3–8s 随机（由 app-module 执行器控制）；单批上限 50 条。
- 不修改平台任何请求参数，不做额外轮询；采集过程保持页面无侵入。
- `QUERY_ALL_EXPORT` 是上述切换 tab 写动作的唯一自动编排入口：在 `.fd-com-tab` 容器内按精确可见文本依次选择“审判”“执行”，每次均点击唯一 `.fd-com-search-btn` 并等待对应列表稳定。稳定判断必须以点击查询前的案件行作为基线；只有案件行节点代际发生替换，或案件行的结构化业务快照发生变化并经过静默期，才可确认本次查询已渲染完成。加载动画、提示层或容器内其他非案件节点的变化不得单独作为完成证据，也不得让仍属于目标分类的旧案件行提前通过。若查询结果与基线完全相同而无法证明 DOM 代际更新，则按 `QUERY_TAB_TIMEOUT` 进入既有的一次严格结构化 API-DOM 探测；探测一致可继续，仍不一致才待人工。目标缺失、重复、不可见或超时统一 `SELECTOR_CHANGED` / `QUERY_TAB_TIMEOUT` 待人工，不用近似文本或索引猜测。
- 单一账号可能只有立案或强执一类记录：若某类切换等待超时，编排器可以继续对该类执行一次结构化平台发现探测；只有探测结果同时证明该类为空（结构化 `total=0` 且当前 DOM 无该类行），或完成严格 API-DOM 匹配时，才可把该类视为已处理并继续导出。`API_DOM_MISMATCH`、无法确认空结果或其他结构/身份硬失败仍必须阻断导出并待人工，禁止用另一类成功结果掩盖。
- 单独 `QUERY_LI` / `QUERY_QZ` 的既有路由和门禁保持兼容；一键流程只有在结构化 `total=0` 且当前分类 DOM 同时为空时，才可把该分类作为确认的空结果并清理同账号、同 `platformAccountId` 的旧类型记录。未取得结构化零结果仍按 `NO_VISIBLE_CASES` 失败且不得清旧数据。

### 3.5 空模板平台发现（`QUERY_LI` / `QUERY_QZ`）

- 前提：后台已选定平台账号并完成登录；空模板必须有合法的两个 12 列表头，且当前查询类型的数据表块必须没有业务数据行。非空模板不进入逐案兼容查询，必须以 `TEMPLATE_NOT_EMPTY` 拒绝。
- 当前登录账号：仅从 `header.userName` 读取，写入导出 C 列；无法读取时返回 `ACCOUNT_UNDETECTED`，不得清空或写入任何本地案件数据。
- 当事人：只认列表字段 `参与人` 的精确结构；立案为 `原告：…；被告：…`，强执为 `申请执行人：…；被执行人：…`，分别写入 A/B。不得从 `caseName`（案件标题）拆词、正则猜测或用模板值补全。字段缺失或歧义时返回 `PARTY_FIELDS_UNAVAILABLE` 并待人工。
- 读取到的每一行按既有精确状态映射、时间与截图规则采集。同行同原被告与案由重复时，按 `申请日期` 取最新一条；日期不可比较时返回 `AMBIGUOUS_LATEST_CASE`，不擅自择一。建档后的状态采集必须继续使用已确认的 `原告 + 被告 + 案由 + sourceApplicationDate` 精确绑定同一条列表记录，禁止退回成“案件标题必须唯一”，否则驳回后重新上传形成的同标题历史记录会被误判歧义。
- 网上立案页当前可见业务行为 0 时返回稳定错误 `NO_VISIBLE_CASES` 并转人工；不得清空或替换同账号既有记录，也不得把零采集包装为成功。
- 预取完成并确认不超过 50 条后，仅原子替换当前登录账号、当前查询类型的本地记录。其他账号、其他类型不受影响。超过上限返回 `BATCH_LIMIT_EXCEEDED`，不启动部分批次。

### 3.6 成功案件跨页面取证（空模板后的补全）

- 网上立案页是 A/B、E、I/J/K 的事实源；成功案件 F/G 的事实源只能是「我的案件」列表（强执为其中的「执行」tab）。空模板不得把导入行或案件标题拆词当作这些字段的来源。
- `QUERY_LI` 与 `QUERY_QZ` 的 F/G 结构化补证都必须直接调用 `POST /yzw/yzw-zxfw-ajfw/api/v1/ajlist`，不得修改 `location.hash`、不得跳转“我的案件”页、不得操作搜索框。执行器只可选择网上立案列表标签；只有“我的案件”标签或 content 在错误路由收到命令时，必须以 `ONLINE_FILING_PAGE_REQUIRED` 失败关闭。立案按来源原告、强执按来源申请执行人精确文本查询；`ajlist.ajlb` 分别固定为审判类别集合和执行类别 `1501_000001-1000`。每页响应必须显式提供可解析的非负整数 `data.total`，缺失、`null`、数组或对象均按 `API_SCHEMA_DRIFT` 转人工，且分页 total/累计条数必须守恒并不超过 50。
- `layy` 与 `ajlist` 没有案件级共享 ID；`sfBh/csfid` 是账号级字段，单独使用会命中多条，禁止作为案件唯一键。`fyid` 与 `nfydm` 属于不同编码空间，禁止直接比较；法院必须以稳定翻译文本 `fymc=cfydmTranslateText` 精确匹配。通常候选必须同时满足：`sfBh=csfid`、`fymc=cfydmTranslateText`、`ajlx=cywlx`、`laay=claay`、`updateTime` 与 `clarq` 规范到同一 `YYYY-MM-DD`，并把 `cajmc` 去掉精确后缀“来源案由+一案”后，按 `与`、中英文逗号、顿号分隔为当事人 token；来源原告和被告必须分别作为完整 token 存在。强执来源案由为空并规范为“暂无”时不比较案由，改为要求 `cajmc` 与来源完整案件名称精确相等，且账号、法院、执行类型、日期仍全部精确匹配并形成唯一候选。允许有案由的标题含额外当事人，但禁止 `includes` 单独决定匹配、禁止改写“诉/与”后做标题全等。
- 上述严格结构必须得到唯一候选，且 `cah/clarq` 完整；零候选、重复候选、字段缺失、日期不可比较或分页不守恒统一 `MYCASE_EVIDENCE_UNAVAILABLE` / `MYCASE_EVIDENCE_AMBIGUOUS` 待人工。F=`clarq`，G=`cah`；不根据 `najzt` 猜状态。
- 结构化补证失败时，任务回执必须优先保留已确认的具体安全错误码（如 `API_SCHEMA_DRIFT`、`PAGINATION_TOTAL_MISMATCH`、`MYCASE_EVIDENCE_AMBIGUOUS`），并附带已完成数/总数；只有无法确定具体原因时才使用 `MYCASE_EVIDENCE_UNAVAILABLE`，禁止把所有子错误折叠成同一个通用码。
- `layy` 来源行回绑本地发现记录时必须逐字段失败关闭，并以不含业务值的 `SOURCE_CASE_NAME_MISMATCH`、`SOURCE_APPLICANT_MISMATCH`、`SOURCE_RESPONDENT_MISMATCH`、`SOURCE_CAUSE_MISMATCH`、`SOURCE_APPLICATION_DATE_MISMATCH` 或 `SOURCE_API_ROW_AMBIGUOUS` 标明首个失败阶段；批次聚合时任何具体码优先于 `MYCASE_EVIDENCE_UNAVAILABLE`，不得由记录顺序掩盖。
- `ajlist` 严格匹配也必须逐阶段失败关闭；记录/来源前置字段缺失、账号/法院/类型/案由/日期/标题不匹配以及案号缺失，只返回对应的稳定大写诊断码，不得包含字段值。所有这些诊断码均按待人工回写。
- 旧的“跳转我的案件页→搜索完整 `sourceCaseName`→DOM 标题全等”链路不再用于 `QUERY_LI` 或 `QUERY_QZ`。成功截图仍取网上立案页已确认的成功列表行。
- `QUERY_QZ` 在网上立案页只处理执行类可见行；当前可见行没有执行类 `caseType` 时返回 `EXECUTION_TAB_REQUIRED`，但不得要求用户跳转到“我的案件”页。`layy/count` 与 `layy` 使用执行类别 `ajlb=zx`，参与人必须为“申请执行人：…；被执行人：…”精确结构。
- 「我的案件」页不再承担 `QUERY_LI` 或 `QUERY_QZ` 的 F/G 补证，也不是 A/B/E/I/J/K 的发现源；查询命令在该路由失败关闭，不得以 `{total:0, needsHuman:0}` 回写成功。
- 任何记录从“无案号”补全为“有案号”时，`clientUid` 必须保持稳定；本地更新和同步不得生成一条旧 UID 与一条新 UID 的重复记录。

## 4. 选择器与改版检测（`extension/content/selectors.js`）

| 键 | 选择器（2026-08-03 三个真实账号联调确认） |
|---|---|
| `header.userName` | `.fd-header-operate .fd-user-name`（当前登录账号） |
| `list.row` | `.fd-case-item` |
| `list.status` | `.fd-header-status`（文本 + fd-status-* class） |
| `list.caseName` | `.fd-header-ajmc` |
| `list.caseType` | `.fd-header-ajlx` |
| `list.fieldItem` / `fieldLabel` / `fieldValue` | `.fd-field-item` / `.fd-field-lable` / `.fd-field-value` |
| `list.spaceBtn` | `.fd-case-space-btn` |
| `list.tab` / `searchBtn` | `.fd-com-tab` / `.fd-com-search-btn` |
| `detail.formItem` | `.uni-forms-item` |

- 改版检测（Task 3.7 已实现）：`assertSelectors(root)` 先校验配置存在，再取第一行探测行内关键选择器（status/caseName/fieldItem）；失效抛 `SELECTOR_CHANGED`（code + selectorKey），任务暂停并提示人工更新配置，**禁止降级猜测**；空列表页（暂无数据）合法不报错。
- 详情页/用户区选择器失效时由对应采集器调用方捕获 `SELECTOR_CHANGED` 统一处理。

## 5. 截图触发

- 需要截图的场景：成功图片（立案成功/强执成功）、驳回图片（驳回/待补充材料）。
- 时机：对应状态页面稳定后，由 content script 使用 `captureElement` 截取已确认的案件行或审核区域；**截图前先确认目标信息已渲染**（详情时间/原因可见）。后台自动任务不得依赖需要用户手势临时授权的 `activeTab/captureVisibleTab`，也不得为截图附加 `chrome.debugger`，避免与浏览器验收控制争用调试会话；禁止截取整页或任意非目标区域。
- 截图归属：立案成功 → H 列；驳回 → K 列；强执成功 → H 列（强执表块）。
- 文字事实与截图独立提交：已精确读取的状态、审核时间和审核意见必须先保留；截图失败仅标记 `SCREENSHOT_CAPTURE_FAILED + needsHuman=true`，不得降级为 `UNKNOWN`、不得清空时间/原因。驳回图片必须沿 `rejectImage` 传播，禁止误写 `successImage`。
- DOM 截图在克隆页面中移除已确认不承载业务事实且无法跨域读取的装饰背景（当前为 `yja-status-bg.png`）；真实平台 DOM 只允许添加截图定位所需的临时属性，且无论成功或失败都必须清理，不得改变其样式、业务内容，也不得移除案件文字、状态、审核时间、审核意见或其他证据内容；截图库的可恢复资源加载日志不得登记为扩展运行错误。
- 一个批次中只要存在 `UNKNOWN`、截图失败或其他 `needsHuman=true` 记录，浏览器查询命令就不得回写成功；必须返回该批次首个稳定错误码（没有更具体错误码时为 `NEEDS_HUMAN`）。后续跨页补证不得掩盖首轮失败。

## 7. 测试

- 单测：状态映射表全覆盖（每条平台文本 → 预期状态词/动作），未知文本 → UNKNOWN；时间解析各格式用例；多条审核历史严格绑定最新时间/意见；截图失败保留已确认文字事实；零可见行与缺少补证基线不得成功或清库。
- simulator（mock 平台页）：登录后首页、立案列表（含四种状态行）、立案详情（成功/驳回）、强执列表、强执详情 —— 每个 fixture 驱动对应采集器，断言结构化输出。
- 真实联调（验收闸门）：用户已登录真实会话，逐采集器核对选择器与输出；验收记录只写脱敏摘要。

## 8. 范围外（不做）

- 不做全量列表分页抓取入库；空模板发现只处理用户当前筛选后的可见列表，超过单批上限须由人工缩小范围后重试。
- 不做状态预测/模糊匹配/正则猜状态（除已固化的精确文本表）。
- 不自动登录、不处理验证码（见 login-module）。
- 不做人工审核流程的模拟（审核结果只读采集）。

## 9. 结构化接口采集契约（2026-08-08）

Content script 必须在当前法院页面上下文中以 `credentials: "include"` 请求已确认的同源接口：`layy` 列表及 `layy/count`、`layyxq/{layyid}/0`、`pz/layymb/{fyid}/{ajlx}` 和 `ajlist`。仅接受 JSON；401/403、登录重定向、非 JSON 或传输异常统一 `needsHuman=true`，不得猜测字段。

列表分页必须以 `count.data` 为总数，逐页累计条数与 total 守恒；超过单批 50 条拒绝执行。`layy` 采集必需字段为 `id/zt/ajmc/dsrMc`，申请时间必须按法院当前列表渲染规则取非空字符串 `tjsj || createTime`：两者均缺失、为空或类型变化才视为字段签名漂移；平台增加未消费的元数据字段不阻断采集。立案案由 `laay` 仍须为非空字符串；强执 `laay` 缺失或为空时规范为页面可见值“暂无”，非字符串类型仍按字段漂移失败。身份映射固定为案件名称=`ajmc`、参与人=`dsrMc`、案由=`laay` 或强执“暂无”、申请时间=`tjsj || createTime`；真实页面交叉验证确认 `laayMz` 不是列表 DOM“案由”的身份值，不得用它绑定。参与人只接受与 DOM 相同的立案“原告：…；被告：…”或强执“申请执行人：…；被执行人：…”精确结构，ISO 日期时间只规范为 `YYYY-MM-DD` 后比较。重复签名，以及 API 与 DOM 的页码/排序/条数或双向五字段身份签名不一致，统一返回 `UNKNOWN` + `needsHuman=true`。DOM 不得按数组下标绑定 `id`，也不得只按案件名称绑定。身份签名精确匹配后必须把 `zt` 的已确认映射状态随发现记录保留；页面状态节点为空或不可识别时使用该接口状态继续流程，不能仅因页面空文字转人工；若页面与接口状态均可识别但映射结果冲突，则返回 `UNKNOWN_STATUS_CONFLICT` 待人工。

案件空间按钮可能创建新标签页；执行器必须接管新标签并在该标签采集详情，不得继续等待原列表标签。列表 content script 与详情 content script 之间的待办只能通过 Service Worker 消息桥接，由 Worker 读写 `chrome.storage.session`；content script 不得直接访问默认仅可信上下文可用的 session storage。桥接失败返回稳定的 `CASE_SPACE_HANDOFF_FAILED`，不得把 Chrome 原始异常降级成通用 `NEEDS_HUMAN`。详情 `data.shjgs[]` 必须按可解析 `shsj` 选择唯一最新记录；最新记录缺字段或最新时间并列时返回待人工，不得按数组顺序或回退历史记录。
