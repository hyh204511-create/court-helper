# court-helper 服务器部署

本目录配套 `server/docker-compose.yml`，用于客户零基础设施的单实例部署：Compose 内置 PostgreSQL 16、本地磁盘存储卷和 Node.js/Fastify `app` 容器；nginx TLS 反向代理保持为可选的 `tls` profile。默认运行不依赖外部 PostgreSQL、COS 或 OSS。

## 快速开始

在客户拿到项目后的部署主机上：

1. 安装 Docker Engine 和 Docker Compose v2.17+（Compose 使用 BuildKit `additional_contexts`）。
2. 进入仓库的 `server/` 目录，复制环境模板：

   ```bash
   cp .env.example .env
   ```

   Windows PowerShell 可使用 `Copy-Item .env.example .env`。

3. 编辑 `.env`，至少填写 `CREDENTIAL_MASTER_KEY`、`ADMIN_INITIAL_PASSWORD` 和 `CORS_EXTENSION_ORIGINS`。生产环境同时应把 `POSTGRES_PASSWORD` 替换为强密码；`CREDENTIAL_MASTER_KEY` 必须是解码后 32 字节的 Base64，可用 `openssl rand -base64 32` 生成。
4. 启动内置服务：

   ```bash
   docker compose up -d
   ```

   需要强制重建镜像时使用 `docker compose up -d --build`。

5. 迁移会自动运行：`db` 健康后，`app` 执行 `server:start`，启动链路中的 H2-3 迁移接线会调用 `runMigrations()`，完成版本化 SQL 后才监听端口。不需要客户单独准备数据库或手动运行迁移命令。
6. 检查容器和应用健康状态：

   ```bash
   docker compose ps
   docker compose logs --tail=100 app
   docker compose exec app node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }).catch((error) => { console.error(error); process.exit(1); })"
   ```

   PostgreSQL 或本地存储不可用时，`/health` 返回 503；应先修复依赖，不要继续采集。

公网部署还需要按下方 TLS 步骤准备域名和证书，然后使用 `docker compose --profile tls up -d`。不启用 profile 时可用于内网或容器内验收；`nginx` 的 `tls` profile 名称和行为不变。

## 环境变量

Compose 只使用下面的规范名称。真实 `.env` 只放部署主机或受控密钥注入中，不提交 git，也不复制进镜像。

| 变量 | 默认/必填 | 用途与存储模式 |
|---|---|---|
| `POSTGRES_DB` | `courthelper` | 内置 PostgreSQL 的数据库名；只在 `pg-data` 首次初始化时生效。 |
| `POSTGRES_USER` | `courthelper` | 内置 PostgreSQL 的用户；只在 `pg-data` 首次初始化时生效。 |
| `POSTGRES_PASSWORD` | `.env.example` 为占位文本 | 内置 PostgreSQL 的密码；生产必须替换为强密码。 |
| `DATABASE_URL` | 留空时默认指向内置 `db:5432` | 可选升级为外部 PostgreSQL；填写外部连接串即可覆盖内置默认。 |
| `LOCAL_STORAGE_DIR` | 示例默认 `/var/lib/court-helper/storage` | 默认本地磁盘存储，数据落在 `storage-data` 卷；留空或不设置时改用外部对象存储。 |
| `OBJECT_STORAGE_ENDPOINT` | 本地模式可选 | 外部 COS/OSS endpoint；启用外部对象存储时必填。 |
| `OBJECT_STORAGE_BUCKET` | 本地模式可选 | 外部 COS/OSS 私有桶；启用外部对象存储时必填。 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | 可选 | 外部 COS/OSS 访问 ID，按云侧最小权限配置。 |
| `OBJECT_STORAGE_ACCESS_KEY_SECRET` | 可选 | 外部 COS/OSS 访问密钥；不要写入 URL、镜像或日志。 |
| `CREDENTIAL_MASTER_KEY` | 必填 | 解码后必须为 32 字节的 Base64 主密钥。 |
| `ADMIN_INITIAL_PASSWORD` | 必填 | 首次启动创建初始 admin 的密码；首次登录后按运维流程更换。 |
| `CORS_EXTENSION_ORIGINS` | 必填 | 逗号分隔的完整扩展 Origin；禁止 `*`。 |
| `CORS_ADMIN_ORIGINS` | 可选，默认空 | 逗号分隔的后台管理 Origin；禁止 `*`。 |
| `PORT` | 可选，默认 `3000` | app 容器内监听端口；当前服务绑定 `127.0.0.1`，TLS profile 依赖该端口。 |
| `SESSION_TTL_SECONDS` | 可选，默认 `28800` | 会话有效期秒数。 |

## 升级到外部 PostgreSQL 或 COS/OSS

### 外部 PostgreSQL

在 `.env` 中填写外部连接串即可：

```dotenv
DATABASE_URL=postgres://USER:PASSWORD@external-host:5432/DB
```

`app` 会使用该值连接外部 PostgreSQL；内置 `db` 服务仍可由同一 Compose 文件启动，但不再是 app 的数据库。切换前应备份目标库并确认网络白名单、迁移权限和恢复方案。

### 外部 COS/OSS

删除或留空 `.env` 中的 `LOCAL_STORAGE_DIR`，再填写 `OBJECT_STORAGE_ENDPOINT`、`OBJECT_STORAGE_BUCKET`，以及云服务要求的访问 ID/密钥。Compose 仍会挂载 `storage-data`，但外部模式下 app 不使用该卷。

当前仓库的 `CloudStorageBackend` 仍是占位实现；本次只提供配置切换路径，未把 COS/OSS 读写适配器纳入部署改造。启用真实云存储前必须完成该适配器并通过健康检查验收，否则 `/health` 会持续 503。

## TLS 文件

`nginx` 服务使用 `tls` profile，并共享 app 的网络命名空间。当前 `server/src/main.ts` 固定监听容器内 `127.0.0.1`，所以 nginx 代理到 `127.0.0.1:3000`；app 服务负责发布宿主机 80/443。

1. 将 `server/deploy/nginx.conf.example` 中的 `server_name example.com` 改为实际域名；证书路径保持 `/etc/nginx/certs/fullchain.pem` 和 `/etc/nginx/certs/privkey.pem`，或同步修改挂载路径。
2. 在部署主机的 `server/deploy/certs/` 放置证书文件。该目录只存在于部署主机，不要提交私钥。
3. 测试环境可使用自签名证书（客户端需要显式信任，不能用于公网生产）：

   ```bash
   mkdir -p deploy/certs
   openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
     -keyout deploy/certs/privkey.pem \
     -out deploy/certs/fullchain.pem \
     -subj "/CN=example.com"
   ```

4. 生产环境使用 CA 或 Let's Encrypt 证书。证书申请、续期不打包进 Compose；更新挂载目录后执行：

   ```bash
   docker compose --profile tls restart nginx
   ```

`nginx.conf.example` 已配置 HTTP→HTTPS 跳转、安全响应头和 10 MiB 上传上限。项目没有 WebSocket/SSE，因此没有长连接升级配置。

## 云服务器部署要点

- 安全组公网只放行 TCP 80/443；SSH 仅允许固定运维 IP。不要开放 3000、5432 或对象存储管理端口。
- 使用内置 PostgreSQL 时，持久化并备份 Compose 的 `pg-data` 卷；外部 PostgreSQL 则只给云主机私网地址或固定出口地址授权，并配置备份、监控和最小数据库权限。
- COS/OSS 使用私有桶和最小权限访问密钥；确认 endpoint、桶地域/域名、出站 HTTPS 和服务账号权限，不要把桶改成公开读。
- DNS 的 A/AAAA 记录指向云主机，证书 SAN 必须覆盖实际域名；HTTP 只负责跳转，业务流量走 HTTPS。
- Let's Encrypt 续期需要单独的证书管理流程；更新挂载目录后 reload/restart nginx。自签名证书只用于受控测试。
- 该部署是单实例，不提供高可用或跨机故障转移；数据库和对象存储的备份、恢复演练由部署方负责。
