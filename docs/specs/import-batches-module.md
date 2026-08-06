# 规格：import-batches-module（后台模板批次）

> 版本：0.1 ｜ 状态：已确认、待实现 ｜ 依据：后台唯一业务入口决策、excel-module、server-module、browser-command-module

## 1. 目标

后台管理页由已登录后台用户上传法院立案/强执 xlsx。服务器只在私有对象存储和 `import_batches` 中保存文件及受控解析基线，供后续后台创建浏览器查询命令引用。

本模块只完成：**上传 → 解析校验 → 私有保存 → 元数据列表 → 原文件下载 → 30 天清理**。

```text
admin_ui Cookie 会话
→ POST /api/v1/import-batches (multipart xlsx)
→ 校验/解析（不返回业务行）
→ 私有对象存储 + import_batches
→ GET 列表（安全摘要）/ GET content（完整文件）
```

## 2. 明确边界

- admin、user 的 **`admin_ui` Cookie 会话**均可上传、列出和下载完整模板。
- extension Bearer 会话不能访问本模块的上传、列表或文件内容接口。
- 文件的完整内容只从下载端点流式返回；列表、创建、日志、错误、浏览器命令 payload、任务状态和页面持久状态不得出现原始业务行、账号或密码。
- `extension-data` 与 `browser_commands` 绑定授权在后续切片实现；本模块**不提供**按 batch UUID 读取解析行的 extension API。
- 本模块不生成 Excel，不修改原文件，不做宏执行、不读取或导入已有图片。

## 3. 数据模型与迁移

新增迁移 `006_import_batches`：

| 字段 | 约束 |
|---|---|
| `id` | UUID 主键 |
| `file_name` | 净化 basename，非空 |
| `object_key` | 私有对象键，唯一，普通响应不返回 |
| `content_type` | 固定 xlsx MIME |
| `byte_size` | `> 0`，最大 20 MiB |
| `sha256` | 64 位小写 hex |
| `li_rows` / `qz_rows` / `skipped_rows` | 非负整数解析摘要 |
| `created_by` | FK `users(id)`，不级联删除 |
| `created_at` / `updated_at` / `expires_at` | `timestamptz`；`expires_at = created_at + 30 天` |

索引：`created_at DESC, id DESC`，`created_by, created_at DESC, id DESC`，`object_key` 唯一。

同一文件由不同用户上传可以独立创建批次；本切片不做按 sha256 幂等合并，避免将真实业务文件的可见性语义与报表导出混淆。

## 4. 上传与解析

### 4.1 multipart 契约

- `POST /api/v1/import-batches`；只接受一个 `file` part，不接受其他字段或多文件。
- 请求必须为 `multipart/form-data`；最大文件 20 MiB。超限返回 `413 PAYLOAD_TOO_LARGE`。
- 仅接受 MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` 与 ZIP magic `PK\x03\x04`。
- 客户端文件名只用于展示；存储前必须净化为 basename，去除控制字符、路径分隔符，保留 Unicode 字母/数字/`_.-（）`；不合法时使用稳定回退名 `import-YYYY-MM-DD.xlsx`。

### 4.2 解析规则

使用 ExcelJS 读取 `Sheet1`，但不向普通响应持久化或回传解析行。

- 最大 2 个工作表；目标 Sheet 仅为 `Sheet1`。缺少目标 sheet 返回 `400 VALIDATION_ERROR(sheet_required)`。
- 最大 5,000 行、12 列；超过返回 `400 VALIDATION_ERROR(template_limit_exceeded)`。
- 第一行必须与 excel-module 中立案 12 列表头逐列完全匹配；否则 `400 VALIDATION_ERROR(template_mismatch)`。
- 强执表头为首个 `A=原告 且 E=强执状态` 的行；缺失则 `400 VALIDATION_ERROR(enforcement_header_required)`。
- 立案/强执行计数规则：A（原告）与 C（账号）均非空的行计入对应块；缺任一项计入 `skippedRows`。空白分隔行不计跳过。
- D 列密码可被解析器读取以完成模板检查，但不得进入响应、日志、错误细节或持久化解析 JSON。
- 仅校验模板结构和摘要；案件状态、案号、当事人等业务字段不进入本切片数据库列。

### 4.3 双写顺序

解析成功后：对象先写入 `import-batches/<uuid>.xlsx`，然后写入数据库。数据库写入失败时删除刚写入对象；补偿失败不得泄露对象键。

## 5. REST

所有端点仅注册 `/api/v1`：

| 方法 | 路径 | 会话 | 响应 |
|---|---|---|---|
| POST | `/import-batches` | admin_ui Cookie + Origin/CSRF | `201 {id,fileName,byteSize,sha256,createdAt,updatedAt,expiresAt,liRows,qzRows,skippedRows}` |
| GET | `/import-batches?limit&cursor` | admin_ui Cookie | `{importBatches:[安全摘要],nextCursor}` |
| GET | `/import-batches/:id/content` | admin_ui Cookie | 原 xlsx 流；`Cache-Control: private, no-store`；attachment；`X-Content-SHA256` |

- `limit` 默认 50，范围 1–200；游标按 `(created_at DESC,id DESC)` 编码。
- 所有登录后台用户看到全体批次，不按创建者隔离。
- UUID 无效或不存在统一 `404 NOT_FOUND`；错误响应不得包含业务明文。
- 创建请求服从现有 Cookie Origin + CSRF 校验；下载 GET 不需要 CSRF。

## 6. 保留策略

`expires_at` 早于当前服务器时间的批次由现有日清理器处理：**先删私有对象，再删元数据**。对象不存在视为可继续；对象/数据库失败保留元数据待下次重试。清理统计只记数量，不记录文件名或对象键。

## 7. 测试与验收

### 自动测试

- 迁移可重复、回滚只移除 `import_batches`、保留既有 001–005。
- admin/user Cookie 成功上传、extension Bearer 和伪装 Cookie 被拒绝、写操作缺 Origin/CSRF 被拒绝。
- 成功上传保存私有对象，返回安全摘要且响应中没有测试账号/密码。
- MIME、magic、multipart 字段、哈希、文件大小、模板/Sheet/强执表头/行列上限均按稳定错误码拒绝。
- 下载流的 SHA256、content disposition、`private, no-store`；列表/上传不泄露 objectKey 或业务行。
- 游标分页、非法 UUID/cursor、对象缺失、对象写入后数据库失败的补偿删除。
- 30 天边界、对象先删、对象删除失败重试。

### 真实验收

使用脱敏 fixture 上传、后台下载校验 SHA256 一致；真实业务 xlsx 只在用户本地测试，不进仓库、Vault 或测试输出。

## 8. 范围外

- 不实现 browser command 与批次的绑定，不实现 extension-data。
- 本模块不单独定义或实现后台页面；批次上传由 Phase 11 的 `/admin/browser-control` 唯一业务入口承载，扩展侧不保留第二套上传入口。
- 不存解析后的完整行、账号、密码、案号、当事人或截图。
- 不支持 xls、csv、宏工作簿、多个业务 Sheet、超过 20 MiB 或超过 5,000 行的文件。
