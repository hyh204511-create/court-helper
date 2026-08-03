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
    - `.fd-com-search`：搜索区（案件名称输入 + `.fd-com-search-btn` 查询按钮；筛选：进展阶段/时间筛选/申请身份/省份，均为「全部」下拉）
    - `.fd-com-list-container`：案件列表容器（空态文案「暂无数据」）
    - `.fd-com-pagination-container`：分页（共 N 条 / 上一页 / 页码 / 下一页）
  - 底部 `uni-tabbar`：首页/服务/日程/消息/我的
  - 服务指引区：在线立案 / 我的立案 / 我的案件 / 文书送达 / 在线交费 / 在线阅卷 / 诉讼工具 / 文书制作 / 其他服务（文字入口，非跳转按钮）
- **列表行结构与详情页结构：未确认**（当前账号名下无案件，需登录有案件的当事人账号后采集）。
- 登录后顶栏文本锚点：`[省份] | [姓名] | 适老服务 | 用户须知`（省份=fd-select-area，姓名=fd-user-name）。

## 6. 未验证清单（登录后，阻塞 Phase 2/3 采集器）

| 项 | 状态 |
|---|---|
| 案件列表行结构（状态文本/详情入口） | **未验证**（需有案件的账号） |
| 案件详情页（立案成功时间/案号/驳回时间/原因）DOM | **未验证** |
| 强执 tab 下的列表（执行案件）行结构 | **未验证** |
| 会话失效表现（401 跳转/提示文案） | 未验证 |
| userAccount 选择器 `.fd-header-operate .fd-user-name` | ✅ 已确认（结构） |

## 7. 风险提示

- 本次访问环境无住宅代理，平台侧 bot 检测可能更激进；批量动作必须保持节流（3–8s）与低频率。
- 登录尝试不做（无凭据 + 全人工边界）；侦察全部为 GET 静态资源与页面内交互。
