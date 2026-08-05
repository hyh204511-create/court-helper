# court-helper 服务器部署

本目录配套 `server/docker-compose.yml`，用于云上单实例 Docker Compose 部署：一个 Node.js/Fastify `app` 容器，按需启用 nginx TLS 反向代理。PostgreSQL 和对象存储不在 Compose 中创建，必须连接客户已有的 PostgreSQL 以及私有腾讯云 COS 或阿里云 OSS 桶。

## 部署前提

- Docker Engine、Docker Compose v2.17+（Compose 使用 BuildKit `additional_contexts`）。
- 本机或云主机可访问外部 PostgreSQL 和 COS/OSS endpoint。
- DNS 已将业务域名解析到云主机；生产证书已准备好。
- 在 `server/` 目录放置本地 `.env`。它包含凭据，不要提交到 git，也不要复制进镜像。

Compose 使用 `server/` 作为主构建上下文，并将仓库根目录命名为 `project` 上下文，因为当前仓库的 `package.json` 和 `package-lock.json` 位于根目录。这样 `server/.dockerignore` 仍会生效。

## 环境变量

下面的名称与 `server/src/config.ts` 一致。Compose 只使用规范名称；`config.ts` 仍兼容的旧别名（例如 `CORS_EXTENSION_ORIGIN`、`COS_SECRET_ID`）不作为部署接口推荐使用。

| 变量 | 必填/默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | 外部 PostgreSQL 连接串；密码只放本机 `.env` 或受控密钥注入中。 |
| `CREDENTIAL_MASTER_KEY` | 必填 | 必须是解码后 32 字节的 Base64。生成：`openssl rand -base64 32`；生成结果只写入本机 `.env`。 |
| `ADMIN_INITIAL_PASSWORD` | 必填 | 首次启动创建初始 admin 的密码；首次登录后按运维流程更换。 |
| `CORS_EXTENSION_ORIGINS` | 必填 | 逗号分隔的完整 Origin，例如浏览器扩展的实际 Origin；禁止 `*`。 |
| `CORS_ADMIN_ORIGINS` | 可选，默认空 | 逗号分隔的后台管理 Origin；禁止 `*`。 |
| `OBJECT_STORAGE_ENDPOINT` | 必填 | 私有 COS/OSS 服务 endpoint，不要把访问密钥拼进 URL。 |
| `OBJECT_STORAGE_BUCKET` | 必填 | 私有桶名称。 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | 可选（按当前 `config.ts`） | COS/OSS 适配器使用的访问 ID。当前配置层不强制校验非空。 |
| `OBJECT_STORAGE_ACCESS_KEY_SECRET` | 可选（按当前 `config.ts`） | COS/OSS 适配器使用的访问密钥。当前配置层不强制校验非空。 |
| `PORT` | 可选，默认 `3000` | app 在容器内监听的端口；当前 `main.ts` 绑定 `127.0.0.1`。启用本 Compose 的 TLS profile 时保持 `3000`，因为示例 nginx 上游固定为该端口。 |
| `SESSION_TTL_SECONDS` | 可选，默认 `28800` | 会话有效期秒数；这是 `config.ts` 支持的额外可选变量。 |

生产部署不要设置 `LOCAL_STORAGE_DIR`：它会让配置切换到本地文件存储，而本规格要求使用外部 COS/OSS。`config.ts` 还接受若干 COS/OSS 旧别名，但 Compose 不注入这些别名，避免同一部署出现多套命名。

不要把真实的 `DATABASE_URL`、密钥、密码、案情数据或证书私钥写入 Dockerfile、Compose、此 README 或镜像层。若要维护团队模板，敏感项只能在受控的 `.env.example` 中使用占位文本；真实值只放部署主机的 `.env` 或密钥管理系统。

## TLS 文件

`nginx` 服务使用 `tls` profile，并共享 app 的网络命名空间。原因是当前 `server/src/main.ts` 固定监听容器内 `127.0.0.1`；因此不能用普通的 `proxy_pass http://app:3000`。app 服务发布宿主机 80/443，nginx 在共享命名空间内监听这两个端口并代理到 `127.0.0.1:3000`。

1. 将 `server/deploy/nginx.conf.example` 中的 `server_name example.com` 改为实际域名；证书路径保持 `/etc/nginx/certs/fullchain.pem` 和 `/etc/nginx/certs/privkey.pem`，或按实际挂载路径同步修改。
2. 在 `server/deploy/certs/` 放置证书文件。该目录只应存在于部署主机，不要提交私钥。
3. 测试环境可用自签名证书（客户端需要显式信任，不能当作公网生产证书）：

   ```bash
   mkdir -p deploy/certs
   openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
     -keyout deploy/certs/privkey.pem \
     -out deploy/certs/fullchain.pem \
     -subj "/CN=example.com"
   ```

4. 生产环境应使用 CA 或 Let's Encrypt 证书。证书申请、续期不打包进本 Compose；续期程序将最新 `fullchain.pem`/`privkey.pem` 写入挂载目录后，执行 `docker compose --profile tls restart nginx`（或向 nginx 发送 reload）使其重新加载。

`nginx.conf.example` 已配置 HTTP→HTTPS 跳转、安全响应头和 10 MiB 上传上限。项目没有 WebSocket/SSE，所以没有 `Upgrade`、`Connection: upgrade` 或长连接配置。

## 迁移与启动

当前根 `package.json` 有 `server:build` 和 `server:start`，但没有 `server:migrate` 脚本；迁移入口是 `server/src/db/migrator.ts` 导出的 `runMigrations()`。先在 `server/` 目录执行：

```bash
docker compose build app
docker compose run --rm --no-deps app node --input-type=module -e "import { Pool } from 'pg'; import { runMigrations } from './server/dist/db/migrator.js'; const pool = new Pool({ connectionString: process.env.DATABASE_URL }); try { console.log(await runMigrations(pool)); } finally { await pool.end(); }"
```

该一次性容器会读取 `.env`，连接外部数据库，创建 `schema_migrations`，按版本顺序执行尚未应用的 `.up.sql`，每个迁移独立事务提交。它不会启动常驻 app，也不会触碰 Compose 外部的数据库之外的服务。生产回滚应先备份并评估影响；`rollbackLastMigration()` 存在于代码中，但没有独立 CLI，不要把回滚绑定到容器启动。

迁移成功后，启用 TLS profile 启动：

```bash
docker compose --profile tls up -d --build
docker compose ps
docker compose logs --tail=100 app
```

如果只需要启动 app 做内部验收，可执行 `docker compose up -d --build`；云上公网访问应使用 `--profile tls`，因为 app 本身绑定容器回环地址，不直接作为公网入口。

## 健康检查验证

健康检查同时探测 PostgreSQL 和对象存储；依赖均可用时返回 200 `{"ok":true}`，否则返回 503。容器内置和 Compose 覆盖的 healthcheck 请求 `/health`。

```bash
docker compose ps
docker compose exec app node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }).catch((error) => { console.error(error); process.exit(1); })"
curl -fsS https://example.com/health
curl -fsS https://example.com/api/v1/health
```

若返回 503，先检查 `DATABASE_URL` 的网络白名单、COS/OSS endpoint 可达性、桶权限和容器日志；不要把健康检查失败当作可继续采集的理由。

## 腾讯云 / 阿里云要点

- 安全组公网只放行 TCP 80/443；SSH 仅允许固定运维 IP。不要开放 3000、5432 或对象存储管理端口。
- 外部 PostgreSQL 只给该云主机的私网地址或固定出口地址授权，并配置备份、监控和最小数据库权限。
- COS/OSS 使用私有桶和最小权限访问密钥；endpoint、桶地域/域名、出站 HTTPS 和服务账号权限要在云侧确认。不要把桶改成公开读。
- DNS 的 A/AAAA 记录指向云主机，证书 SAN 必须覆盖实际域名；HTTP 只负责跳转，业务流量走 HTTPS。
- Let's Encrypt 续期需要单独的证书管理流程；更新挂载目录后 reload/restart nginx。自签名证书只用于受控测试。
- 该部署是单实例，不提供高可用或跨机故障转移；数据库和对象存储的备份、恢复演练由外部服务负责。

## 当前代码风险提示

当前 `server/src/storage/cloud.ts` 的 `CloudStorageBackend` 仍是占位实现：`check()` 返回 false，读写方法也会报告不可用。仅完成本部署配置并不能使 COS/OSS 业务读写上线；在启用真实云存储前必须完成并验收对应适配器，否则 `/health` 会持续 503。这不在本次部署文件范围内。
