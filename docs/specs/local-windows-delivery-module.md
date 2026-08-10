# 规格：local-windows-delivery-module（Windows 本地一键交付）

> 版本：0.1 | 状态：已确认 | 目标版本：0.3.0

## 1. 目标

为单台 Windows 10/11 x64 电脑提供一个 `court-helper-windows-x64-setup.exe` 安装包。安装包内置本地后台、私有 PostgreSQL、OCR 助手和固定 ID 的 Edge 扩展，普通用户无需安装 Node.js、Python、PostgreSQL 或执行脚本。

## 2. 运行边界

- 后台只监听 `127.0.0.1:3000`；PostgreSQL 只监听回环地址的私有端口 `55432`；OCR 只监听 `127.0.0.1:8765`。
- 本地数据库名固定为 `courthelper`。启动时清除/忽略用户级 `DATABASE_URL`，只使用安装目录受保护配置。
- 真实业务数据只写入 `%ProgramData%\CourtHelper`，不写入安装包、Git 或知识库。
- 安装器申请管理员权限，使用 WinSW 注册本项目后台服务并注册私有 PostgreSQL 服务；不修改 Edge 企业策略、不开放防火墙入站端口。
- 首次安装需要用户在 Edge 扩展页确认一次“加载已解压的扩展”；之后扩展 action 打开本地控制台。

## 3. 生命周期

- 安装：生成数据库密码、凭据主密钥和管理员初始密码配置，初始化数据库并运行迁移，启动服务并执行健康检查。
- 升级：停止服务、创建数据库备份、替换程序、运行兼容迁移；数据目录和主密钥保持不变。
- 卸载：默认删除程序和服务但保留数据/备份；显式确认后才删除 `%ProgramData%\CourtHelper`。
- 诊断：检查服务状态、三个回环健康端点、扩展目录、端口绑定和配置权限，不打印秘密或业务数据。

## 4. 发布契约

`npm run release:windows-local` 生成 `release/court-helper-<version>-windows-x64-setup.exe`，同时生成 staging 目录、`VERSION.json`、`checksums.sha256` 和 `THIRD_PARTY_NOTICES.md`。发布树禁止包含 `.env`、私钥、账号文件、Excel、图片、日志、测试和 `node_modules` 源目录。

## 5. 范围外

- 本期不提供局域网多机共享、云端同步或 Edge 商店/企业策略静默安装。
- 本期不改变案件、查询、登录、报表和扩展命令 API。
