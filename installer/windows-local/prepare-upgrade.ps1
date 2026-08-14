param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path $env:ProgramData 'CourtHelper'
$envPath = Join-Path $dataRoot 'config\service.env'
$pgDump = Join-Path $InstallRoot 'runtime\postgres\bin\pg_dump.exe'
$pgReady = Join-Path $InstallRoot 'runtime\postgres\bin\pg_isready.exe'
$lockProbe = Join-Path $InstallRoot 'runtime\postgres\bin\icudt67.dll'
if (-not (Test-Path $envPath)) { exit 0 }

$databaseLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -like 'DATABASE_URL=*' } | Select-Object -First 1
if (-not $databaseLine -or $databaseLine -notmatch '^DATABASE_URL=postgres://courthelper:([^@]+)@127\.0\.0\.1:55432/courthelper$' -or -not (Test-Path $pgDump) -or -not (Test-Path $pgReady)) { throw '无法验证本地数据库配置，升级已停止。' }
$databasePassword = $Matches[1]

function Stop-AndWait([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction Stop
  if ($service.Status -ne 'Stopped') { Stop-Service -Name $Name -Force -ErrorAction Stop }
  $service = Get-Service -Name $Name -ErrorAction Stop
  $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  if ($service.Status -ne 'Stopped') { throw "$Name 服务停止超时。" }
}

function Start-AndWait([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction Stop
  if ($service.Status -ne 'Running') { Start-Service -Name $Name -ErrorAction Stop }
  $service = Get-Service -Name $Name -ErrorAction Stop
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  if ($service.Status -ne 'Running') { throw "$Name 服务启动超时。" }
}

function Wait-PostgresReady {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    & $pgReady -h 127.0.0.1 -p 55432 -d courthelper | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'PostgreSQL 未能在限定时间内就绪，升级已取消。'
}

function Wait-PostgresQuiescent {
  if (-not (Test-Path -LiteralPath $lockProbe)) { throw 'PostgreSQL 运行时锁探针缺失，升级已停止。' }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $backendStopped = (Get-Service -Name CourtHelperBackend -ErrorAction SilentlyContinue).Status -eq 'Stopped'
    $postgresStopped = (Get-Service -Name CourtHelperPostgres -ErrorAction Stop).Status -eq 'Stopped'
    $listeners = @(Get-NetTCPConnection -LocalPort 55432 -State Listen -ErrorAction SilentlyContinue)
    $unlocked = $false
    $probe = $null
    try {
      $probe = [IO.File]::Open($lockProbe, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $unlocked = $true
    } catch [IO.IOException] {
      $unlocked = $false
    } finally {
      if ($probe) { $probe.Dispose() }
    }
    if ($backendStopped -and $postgresStopped -and $listeners.Count -eq 0 -and $unlocked) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw 'PostgreSQL 运行时未能在限定时间内完全停止，升级已取消。'
}

try {
  if (Get-Service -Name CourtHelperBackend -ErrorAction SilentlyContinue) {
    Set-Service CourtHelperBackend -StartupType Disabled
    Stop-AndWait 'CourtHelperBackend'
  }

  Start-AndWait 'CourtHelperPostgres'
  Wait-PostgresReady
  $env:PGPASSWORD = $databasePassword
  $backupRoot = Join-Path $dataRoot 'backups'
  New-Item -ItemType Directory -Force $backupRoot | Out-Null
  $backup = Join-Path $backupRoot ("pre-upgrade-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  & $pgDump -h 127.0.0.1 -p 55432 -U courthelper -d courthelper -Fc -f $backup
  if ($LASTEXITCODE -ne 0) { throw '升级前数据库备份失败，安装已停止。' }

  Stop-AndWait 'CourtHelperPostgres'
  Wait-PostgresQuiescent
} catch {
  $failure = $_
  Start-Service CourtHelperPostgres -ErrorAction SilentlyContinue
  if (Get-Service -Name CourtHelperBackend -ErrorAction SilentlyContinue) {
    Set-Service CourtHelperBackend -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service CourtHelperBackend -ErrorAction SilentlyContinue
  }
  throw $failure
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
