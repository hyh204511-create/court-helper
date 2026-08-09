# 规格：deployment-delivery-module（腾讯云生产交付）

> 版本：0.1 ｜ 状态：已确认 ｜ 目标版本：0.2.0

## 1. 目标

把 court-helper 交付为可复建的单实例生产系统：腾讯云轻量应用服务器运行后台、PostgreSQL 与私有文件存储；1–5 台 Windows Edge 客户端运行固定 ID 扩展和本地 OCR 助手。后台唯一生产地址为 `https://court.hyhbrand.xyz`。

## 2. 生产拓扑与边界

- Ubuntu 24.04 + Docker Compose v2；`app`、PostgreSQL 16 和 Nginx 单机运行。
- 公网只开放 80/443，SSH 只允许固定运维 IP；3000、5432、8765 不得公网开放。
- 应用对象存储使用 Compose 私有卷。COS/OSS 业务适配器仍为范围外，不得配置占位实现。
- COS 只接收客户端加密后的运维备份；备份保留不超过 30 天，不得公开读。
- Nginx 关闭访问日志，强制 HTTPS，上传限制至少覆盖 20 MiB 文件加 multipart 开销。
- 生产秘密只存在 root-only `.env`、证书目录或受控密码库，不进入 Git、镜像、普通交付包和知识库。

## 3. 扩展发布配置

- 生产服务 Origin 固定为 `https://court.hyhbrand.xyz`；Setup 只接受该精确 Origin。
- 拒绝 HTTP、通配域名、用户名/密码、非根路径、query、fragment 与其他端口。
- 生产 Manifest host permissions 仅包含法院站点、本机 OCR 和生产后台，不包含本机开发后台。
- Manifest 写入一次性生成的公开 `key`，保证解压安装 ID 稳定；私钥不得进入仓库或交付 ZIP。
- 服务端 CORS 只允许同源后台和固定 `chrome-extension://<id>`，不得使用 `*`。

## 4. 发布包契约

`npm run release` 必须先执行测试与构建，再生成 `court-helper-0.2.0-delivery.zip`：

```text
server/       生产 Compose、Dockerfile、迁移、Nginx、部署/升级/回滚/备份/恢复脚本
extension/    可直接加载的生产扩展目录
ocr-helper/   Windows 安装、启动、健康检查、卸载脚本
docs/         Markdown、DOCX、PDF 客户文档
VERSION.json  版本、域名、扩展 ID、构建时间与文件清单
checksums.sha256
THIRD_PARTY_NOTICES.md
```

- 发布脚本不得复制 `.env`、证书/私钥、扩展私钥、Excel、截图、测试、node_modules、日志或真实业务数据。
- OCR 使用隔离 venv 与 `ddddocr==1.6.1`，只运行 `login-helper-server.py --ocr-only` 并监听 `127.0.0.1:8765`。
- 安装与卸载脚本只能管理本项目创建的目录和计划任务。

## 5. 部署、备份与回滚

- 版本目录为 `/opt/court-helper/releases/<version>`，`/opt/court-helper/current` 指向当前版本。
- 部署前验证 DNS、证书、环境变量与 Compose；启动后验证迁移、`/health`、TLS、安全响应头、CORS 和后台登录。
- 每日备份 PostgreSQL 与私有存储，归档后加密再上传私有 COS；恢复必须在隔离目录演练并校验健康状态。
- 升级前创建数据库/存储备份和腾讯云快照；失败时切回上一版本并恢复兼容数据。不可逆迁移必须提供显式恢复步骤。

## 6. 文档交付

交付普通用户手册、管理员手册、腾讯云运维手册、故障处理手册和验收单，均保留 Markdown 源稿并输出 DOCX/PDF。所有示例必须脱敏，文档不得包含秘密或真实业务内容。

## 7. 验收

1. 全量测试、服务端构建、扩展构建和发布包敏感文件扫描通过。
2. 生产扩展 ID 在两台 Edge 上一致，且只能连接生产后台与本机 OCR。
3. Ubuntu 24.04 新机可按文档完成 Compose 部署、HTTPS 健康检查与重启恢复。
4. 脱敏数据走通导入、配对、登录、查询、截图同步、导出与再下载。
5. 备份可在隔离环境恢复；发布包 SHA-256 校验通过。

## 8. 范围外

- 不做多实例高可用、Kubernetes、Redis、消息队列或自动跨机故障转移。
- 不实现 COS/OSS 业务对象存储适配器，不公开私有文件。
- 不发布 Edge 商店包或企业策略安装包；本期为固定 ID 解压安装。
- 不把腾讯云账号、SSH 凭据、证书私钥或任何真实业务数据写入交付物。
