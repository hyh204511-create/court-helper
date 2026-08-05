# 登录模块测试环境加固与验证码链路测试补强（实施计划书）

> 日期：2026-08-05
> 规格基线：`docs/specs/login-module.md` v0.4（提交 `3774ccf`）
> 计划来源：Codex sol（gpt-5.6-sol, medium）只读勘察拟定 + Hermes 大脑确认落盘
> 背景事故：2026-08-05 全量测试出现 3 个间歇失败（`/accounts` 空数组、`/ocr` 返回 OCR_FAILED 而非 DDDDOCR_MISSING）；根因 = 8765 端口残留旧 login-helper-server.py 实例（Windows `SO_REUSEADDR` 允许多进程同端口监听），测试 `withServer` 连到旧实例（其临时账号文件已删除、无 mock 环境）。清理残留后 189 测试全绿，确认代码无 bug，仅测试环境隔离不足。

## 1. 目标

1. 消除测试对 8765 空闲的依赖：`withServer` 用独立随机端口起子进程，杜绝残留实例抢答。
2. `stopServer` 强杀兜底：kill 后确认退出，超时 `taskkill //PID <pid> //T //F` 并再次确认。
3. 补验证码链路测试：`refreshCaptcha` 三分支（经 `doAutoLogin` 现有公开入口隔离）与 `fetchCaptchaBase64` 边界（非 JPEG 跳过、多图取首个 JPEG）。

## 2. 原子任务

### 任务 1：`--port` 参数（服务端）

- **测试先行**：改 `tests/login-helper-server.test.js`——`startServer` 生成随机端口（20000–60000）经 `--port` 传入，`BASE` 动态化；未实现 `--port` 时 argparse 报错退出 → `waitHealthy` 失败（Red）。
- **最小实现**：`scripts/login-helper-server.py` `main()` 加 `--port`（默认 8765），`PORT` 不再为模块常量直用。
- **验收**：`node --test tests/login-helper-server.test.js` 绿。
- **原子提交**：`test(login): use ephemeral port for helper server tests` → `feat(login): add --port to helper server`（提交由 Hermes 大脑执行）。

### 任务 2：`stopServer` 强杀兜底

- `tests/login-helper-server.test.js`：kill 后 `Promise.race` 2s 超时未退出 → 按 `child.pid` 执行 `taskkill //PID <pid> //T //F`（git-bash 需双斜杠），再等 exit；`after` 钩子对残留 children 同样处理。
- **验收**：测试文件全绿 + 手动模拟残留进程（先起一个 8765 服务器）跑测试仍绿。
- **原子提交**：`fix(login): force-kill helper server children on stop timeout`。

### 任务 3：验证码链路测试补强

- `tests/login-auto.test.js`：
  - `fetchCaptchaBase64`：多图场景（首个 JPEG data URL 优先，PNG/空 src 跳过）——现有测试已覆盖 png/空 src 单图，补多图次序；
  - `refreshCaptcha` 三分支经 `doAutoLogin` 隔离：① 点击后 src 变化 → 重试成功（已有「首次超时只刷新一次」覆盖）；② src 不变 → 超时 → `NEEDS_HUMAN` 且不读旧图（已有「验证码刷新超时不读取旧图」覆盖）；③ 页面无有效 JPEG 验证码图 → 不点击、不二次提交 → `NEEDS_HUMAN`（**新增**）。
- **验收**：`node --test tests/login-auto.test.js` 绿。
- **原子提交**：`test(login): cover captcha refresh branches and multi-image pickup`。

### 任务 4：全量回归

- `npm test` 全绿（基线 189）；`npm run build` 不涉及（未改 extension/）。
- **原子提交**：无源码变化不提交。

## 3. 风险与回滚

| 风险 | 影响 | 控制 |
|---|---|---|
| 随机端口仍被占用 | spawn 失败/连错 | 端口范围 20000–60000 + `waitHealthy` 已存在 8s 超时；仍失败则测试报错而非静默连错 |
| `taskkill` 参数在 git-bash 被转义 | 强杀失效 | 使用 `//PID` 双斜杠（MSYS 转义约定），kill 后确认 exitCode |
| 本机 Hermes venv 真装 ddddocr 干扰 OCR mock | 错误码漂移 | 测试已用 PYTHONPATH mock 目录优先注入（现有机制），任务 1/2 不改该机制 |
| `refreshCaptcha` 未导出导致测试只能走 `doAutoLogin` | 分支覆盖不全 | 现有两条刷新测试已走该入口；任务 3 只补「无有效图」分支，不新增导出（不碰 extension/） |

**回滚**：每个原子任务独立提交，出问题 `git revert <commit>` 单个回滚；`--port` 回滚不影响插件（插件默认仍 8765）。

## 4. 范围外

- 不改 `extension/` 下任何业务代码（含 login-auto.js 导出面）。
- 不改验证码重试语义（仍最多提交 2 次、刷新 1 次、节流 3–8s）。
- 不加新依赖；不改本地服务 HTTP 契约（除新增可选 `--port`）。
- 真实登录页复核（验证码图点击刷新行为）属另一验收闸门，不在本计划内。
