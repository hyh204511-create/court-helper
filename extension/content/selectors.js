// selectors.js — 平台页面选择器集中配置（唯一权威）
// 依据 docs/engineering/platform-recon-2026-08-03.md（2026-08-03 三个真实账号实测确认）。
// 站点改版时只需改这里；采集器探测失效会抛 SELECTOR_CHANGED（见 case-collectors.js）。
export const SELECTORS = {
  // 登录页路由与表单候选集合；文本锚点由 login-auto.js 做精确文本过滤。
  route: {
    login: "#/pagesGrxx/pc/login",
  },
  login: {
    accountInput: "input[type=text].uni-input-input",
    passwordInput: "input[type=password].uni-input-input",
    captchaInput: "input[type=text].uni-input-input",
    captchaImage: "img",
    // 平台使用可点击 view 而非稳定的 button 标签，使用基础候选集后按文本过滤。
    submitButton: "*",
    passwordTab: "*",
  },
  // 顶栏用户区（login-module 用）
  header: {
    userName: ".fd-header-operate .fd-user-name",
  },
  // 案件列表页（网上立案 pagesWsla/pc/list 与 我的案件 pages/pc/case-list 共用）
  list: {
    row: ".fd-case-item",
    status: ".fd-header-status",
    caseName: ".fd-header-ajmc",
    caseType: ".fd-header-ajlx",
    fieldItem: ".fd-field-item",
    fieldLabel: ".fd-field-lable",
    fieldValue: ".fd-field-value",
    spaceBtn: ".fd-case-space-btn",
    container: ".fd-com-list-container",
    searchBox: ".fd-com-search .uni-searchbar__box",
    searchInput: ".fd-com-search input",
    // 顶部案件类型 tab（调解/保全/审判/执行/破产/信访）与查询按钮
    tab: ".fd-com-tab",
    searchBtn: ".fd-com-search-btn",
  },
  // 案件详情页（案件空间 pagesWsla/common/wsla/detail）
  detail: {
    section: ".uni-section, uni-section[title]",
    sectionTitle: ".uni-section__content-title",
    formItem: ".uni-forms-item",
  },
};

/** 采集器关键选择器（失效即 SELECTOR_CHANGED） */
export const CRITICAL_SELECTORS = [
  "list.row",
  "list.status",
  "list.caseName",
  "list.fieldItem",
];
