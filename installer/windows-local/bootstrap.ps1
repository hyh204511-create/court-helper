param([Parameter(Mandatory=$true)][string]$InstallRoot, [Parameter(Mandatory=$true)][string]$AdminPasswordFile)
$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path $env:ProgramData 'CourtHelper'
$runtimeRoot = Join-Path $InstallRoot 'runtime'
$pgRoot = Join-Path $runtimeRoot 'postgres'
$pgData = Join-Path $dataRoot 'postgres'
$configRoot = Join-Path $dataRoot 'config'
$storageRoot = Join-Path $dataRoot 'storage'
$backupRoot = Join-Path $dataRoot 'backups'
New-Item -ItemType Directory -Force -Path $pgData,$configRoot,$storageRoot,$backupRoot | Out-Null
$requiredFiles = @(
  (Join-Path $runtimeRoot 'node.exe'),
  (Join-Path $runtimeRoot 'CourtHelperBackend.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\initdb.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\pg_ctl.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\psql.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\createdb.exe'),
  (Join-Path $runtimeRoot 'ocr\court-helper-ocr.exe')
)
foreach ($requiredFile in $requiredFiles) { if (-not (Test-Path -LiteralPath $requiredFile)) { throw "安装组件缺失：$requiredFile" } }

function Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($b)
  } finally {
    $rng.Dispose()
  }
  [Convert]::ToBase64String($b)
}
function SecretUrl([int]$bytes) { (Secret $bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
if (-not (Test-Path -LiteralPath $AdminPasswordFile)) { throw '安装器未提供管理员密码。' }
$AdminPassword = Get-Content -Raw -LiteralPath $AdminPasswordFile
Remove-Item -LiteralPath $AdminPasswordFile -Force
if ($AdminPassword.Length -lt 12) { throw '管理员密码至少需要 12 位。' }
if ($AdminPassword -notmatch '^[A-Za-z0-9!@%_\-]{12,128}$') { throw '管理员密码包含不支持的字符。' }
$dbPassword = SecretUrl 24
$masterKey = Secret 32
$versionFile = Join-Path $InstallRoot 'VERSION.json'
$extensionId = if (Test-Path $versionFile) { ((Get-Content -Raw $versionFile | ConvertFrom-Json).extensionId) } else { 'LOCAL_EXTENSION_ID' }
$envPath = Join-Path $configRoot 'service.env'
$pwFile = Join-Path $configRoot 'postgres-password.tmp'
if (-not (Test-Path $envPath)) {
  Set-Content -LiteralPath $pwFile -Value $dbPassword -Encoding ascii
  @("PORT=3000", "DATABASE_URL=postgres://courthelper:$dbPassword@127.0.0.1:55432/courthelper", "CREDENTIAL_MASTER_KEY=$masterKey", "ADMIN_INITIAL_PASSWORD=$AdminPassword", "CORS_ADMIN_ORIGINS=http://127.0.0.1:3000", "CORS_EXTENSION_ORIGINS=chrome-extension://$extensionId", "LOCAL_STORAGE_DIR=$storageRoot", "OBJECT_STORAGE_ENDPOINT=local://private", "OBJECT_STORAGE_BUCKET=local", "LOCAL_LOGIN_HELPER_AUTOSTART=true", "LOCAL_LOGIN_HELPER_COMMAND=$InstallRoot\runtime\ocr\court-helper-ocr.exe", "LOCAL_WINDOWS_DELIVERY=true", "LOCAL_EXTENSION_DIR=$InstallRoot\extension") | Set-Content -LiteralPath $envPath -Encoding UTF8
}
$dataAcl = New-Object Security.AccessControl.DirectorySecurity
$dataAcl.SetAccessRuleProtection($true, $false)
$accessRules = @(
  @('S-1-5-18', [Security.AccessControl.FileSystemRights]::FullControl),
  @('S-1-5-32-544', [Security.AccessControl.FileSystemRights]::FullControl),
  @('S-1-5-19', [Security.AccessControl.FileSystemRights]::Modify)
)
foreach ($accessRule in $accessRules) {
  $identity = New-Object Security.Principal.SecurityIdentifier($accessRule[0])
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $identity,
    $accessRule[1],
    ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$dataAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $dataRoot -AclObject $dataAcl
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if (Test-Path -LiteralPath $pwFile) {
  $pwAcl = Get-Acl -LiteralPath $pwFile
  $pwReadRule = New-Object Security.AccessControl.FileSystemAccessRule(
    $currentUserSid,
    [Security.AccessControl.FileSystemRights]::Read,
    [Security.AccessControl.InheritanceFlags]::None,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $pwAcl.SetAccessRule($pwReadRule)
  Set-Acl -LiteralPath $pwFile -AclObject $pwAcl
}
$currentUserDataRule = New-Object Security.AccessControl.FileSystemAccessRule(
  $currentUserSid,
  [Security.AccessControl.FileSystemRights]::Modify,
  ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$dataAcl.AddAccessRule($currentUserDataRule)
Set-Acl -LiteralPath $dataRoot -AclObject $dataAcl
$pgCtl = Join-Path $pgRoot 'bin\pg_ctl.exe'; $initdb = Join-Path $pgRoot 'bin\initdb.exe'
if ((Test-Path $initdb) -and -not (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
  if (-not (Test-Path -LiteralPath $pwFile)) { throw 'PostgreSQL 初始化密码文件缺失。' }
  try {
    & $initdb -D $pgData -U courthelper "--pwfile=$pwFile" --encoding=UTF8 --auth=scram-sha-256 | Out-Null
    $initDbExitCode = $LASTEXITCODE
  } finally {
    [void]$dataAcl.RemoveAccessRuleSpecific($currentUserDataRule)
    Set-Acl -LiteralPath $dataRoot -AclObject $dataAcl
  }
  if ($initDbExitCode -ne 0) { throw 'PostgreSQL 数据目录初始化失败。' }
  Remove-Item -LiteralPath $pwFile -Force
} else {
  [void]$dataAcl.RemoveAccessRuleSpecific($currentUserDataRule)
  Set-Acl -LiteralPath $dataRoot -AclObject $dataAcl
}
if (-not (Get-Service CourtHelperPostgres -ErrorAction SilentlyContinue)) { & $pgCtl register -N CourtHelperPostgres -D $pgData -S auto -o '-p 55432' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 服务注册失败。' } }
Start-Service CourtHelperPostgres -ErrorAction Stop
$pgReady = Join-Path $pgRoot 'bin\pg_isready.exe'
for ($i=0; $i -lt 30 -and (Test-Path $pgReady); $i++) { & $pgReady -h 127.0.0.1 -p 55432 -d postgres | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
& $pgReady -h 127.0.0.1 -p 55432 -d postgres | Out-Null
if ($LASTEXITCODE -ne 0) { throw '本地 PostgreSQL 启动健康检查失败。' }
$databaseLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -like 'DATABASE_URL=*' } | Select-Object -First 1
if ($databaseLine -notmatch '^DATABASE_URL=postgres://courthelper:([^@]+)@127\.0\.0\.1:55432/courthelper$') { throw '无法验证本地数据库配置。' }
$env:PGPASSWORD = $Matches[1]
try {
  $psql = Join-Path $pgRoot 'bin\psql.exe'
  $createdb = Join-Path $pgRoot 'bin\createdb.exe'
  $databaseExists = & $psql -h 127.0.0.1 -p 55432 -U courthelper -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'courthelper'"
  if ($LASTEXITCODE -ne 0) { throw '无法检查本地数据库。' }
  if (($databaseExists | Out-String).Trim() -ne '1') {
    & $createdb -h 127.0.0.1 -p 55432 -U courthelper -E UTF8 courthelper
    if ($LASTEXITCODE -ne 0) { throw '创建本地 courthelper 数据库失败。' }
  }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
$wrapper = Join-Path $runtimeRoot 'CourtHelperBackend.exe'
$wrapperConfig = Join-Path $runtimeRoot 'CourtHelperBackend.xml'
$backendScript = Join-Path $InstallRoot 'installer\windows-local\start-backend.ps1'
$xmlBackendScript = [Security.SecurityElement]::Escape($backendScript)
$xmlInstallRoot = [Security.SecurityElement]::Escape($InstallRoot)
$xmlEnvPath = [Security.SecurityElement]::Escape($envPath)
$xmlDataRoot = [Security.SecurityElement]::Escape($dataRoot)
@"
<service>
  <id>CourtHelperBackend</id>
  <name>Court Helper Backend</name>
  <description>法院查询助手本地后台</description>
  <executable>powershell.exe</executable>
  <arguments>-NoProfile -ExecutionPolicy Bypass -File &quot;$xmlBackendScript&quot; -InstallRoot &quot;$xmlInstallRoot&quot; -EnvironmentFile &quot;$xmlEnvPath&quot;</arguments>
  <depend>CourtHelperPostgres</depend>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <logpath>$xmlDataRoot\logs</logpath>
</service>
"@ | Set-Content -LiteralPath $wrapperConfig -Encoding UTF8
if (-not (Get-Service CourtHelperBackend -ErrorAction SilentlyContinue)) { & $wrapper install | Out-Null; if ($LASTEXITCODE -ne 0) { throw '后台服务注册失败。' } }
& $wrapper start | Out-Null
if ($LASTEXITCODE -ne 0) { throw '后台服务启动失败。' }
