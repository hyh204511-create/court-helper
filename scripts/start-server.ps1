# court-helper 服务器启动脚本（本机验收/开发用）
# 用户级环境变量 DATABASE_URL 指向三客一危的 assistant 库，会覆盖 server/.env 的配置（node --env-file 不覆盖已有变量）
# 本脚本先移除污染变量，再加载 server/.env 启动
$ErrorActionPreference = 'Stop'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Set-Location 'C:\Users\28368\Documents\Edge 浏览器插件\court-helper\server'
node --env-file=.env dist\main.js
