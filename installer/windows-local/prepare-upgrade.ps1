param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path $env:ProgramData 'CourtHelper'
$envPath = Join-Path $dataRoot 'config\service.env'
$wrapper = Join-Path $InstallRoot 'runtime\CourtHelperBackend.exe'
$pgDump = Join-Path $InstallRoot 'runtime\postgres\bin\pg_dump.exe'
if (-not (Test-Path $envPath)) { exit 0 }
if (Test-Path $wrapper) { & $wrapper stop | Out-Null }
$databaseLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -like 'DATABASE_URL=*' } | Select-Object -First 1
if (-not $databaseLine -or $databaseLine -notmatch '^DATABASE_URL=postgres://courthelper:([^@]+)@127\.0\.0\.1:55432/courthelper$' -or -not (Test-Path $pgDump)) { throw '无法验证本地数据库配置，升级已停止。' }
$env:PGPASSWORD = $Matches[1]
$backupRoot = Join-Path $dataRoot 'backups'
New-Item -ItemType Directory -Force $backupRoot | Out-Null
$backup = Join-Path $backupRoot ("pre-upgrade-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
& $pgDump -h 127.0.0.1 -p 55432 -U courthelper -d courthelper -Fc -f $backup
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { throw '升级前数据库备份失败，安装已停止。' }
Stop-Service CourtHelperPostgres -Force -ErrorAction SilentlyContinue
