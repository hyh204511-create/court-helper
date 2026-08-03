# AGENTS.md — court-helper（法院立案/强执查询助手）

## 项目
- **目标**：Edge 插件辅助法院立案/强执状态查询、截图存证、Excel 填表导出（见 `IDEA.md`、根目录 `.hermes/plans/`）。
- **结构**：`extension/`（MV3 插件）、`simulator/`（mock 平台页）、`tests/`（node 测试）、`docs/specs/`（规格）、`scripts/`（工具脚本）。
- **环境**：Windows + git-bash；Node 测试 `npm test`。

## 铁律（违反即违规）
1. **写代码前必须有规格**：`docs/specs/<module>.md`。规格不存在 = 不准动工。
2. **编码范围 = 规格范围**。规格"范围外"节写明的不做；规格有歧义 → 停手，不许猜。
3. **先测试后实现**（TDD）：先写失败测试 → 实现 → 测试绿 → 提交。
4. **提交规范**：`type(module): description`（feat/fix/test/docs/chore），每完成一个原子步骤提交一次。

## 业务边界（本插件特有）
- **登录全人工**：插件不自动填充账号/密码/验证码，不存储凭据，不代替人工登录。只检测登录状态、识别当前账号、监测会话失效。
- **状态识别**：平台文本 → 模板状态词按 `docs/specs/query-module.md` 映射表执行；**未知文本 → UNKNOWN 标记待人工，禁止猜测**。
- **敏感数据**：真实案号、原告/被告名、身份证号、密码、驳回原因、截图 = 真实业务数据，**不得提交 git、不得写入知识库、不得外传**。`*.xlsx` 已 ignore（唯一例外：`tests/fixtures/*.xlsx` 脱敏测试模板）。真实模板只放本地私有位置。
- **节流**：批量查询每案间隔 3–8s 随机、单批上限 50 条、失败重试 1 次后标记待人工。
- 涉及批量任务/识别链路改动前先读知识库对应模块笔记。

## Obsidian 知识库
本项目知识库 = `C:\Users\28368\Documents\Obsidian\Vaults\Codex-Knowledge`，入口：`Projects/法院立案强执查询助手/` 下的 `项目索引.md`、`Architecture.md`、`LoginModule.md`、`QueryModule.md`、`ExcelModule.md`、`Todo.md`。
**注意**：全局 `OBSIDIAN_VAULT_PATH` 默认指向爬虫项目的 PolicySpider-KB；如用 obsidian skill，先 `export OBSIDIAN_VAULT_PATH='C:\Users\28368\Documents\Obsidian\Vaults\Codex-Knowledge'`。

## 新会话引导（防上下文污染，必读）
新对话从这里开始，**先做知识库引导**，再动手：
1. 读 `Projects/法院立案强执查询助手/项目索引.md` 与 `Architecture.md`。
2. 任务涉及某模块 → 只读对应模块笔记（LoginModule/QueryModule/ExcelModule），不要把整个知识库读进上下文。
3. 任务完成 → 更新对应模块笔记或 Todo（写回 Obsidian）。
