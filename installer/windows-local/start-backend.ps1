param([Parameter(Mandatory=$true)][string]$InstallRoot, [Parameter(Mandatory=$true)][string]$EnvironmentFile)
$ErrorActionPreference = 'Stop'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
$node = Join-Path $InstallRoot 'runtime\node.exe'
$main = Join-Path $InstallRoot 'server\dist\main.js'
Set-Location (Join-Path $InstallRoot 'server')
& $node "--env-file=$EnvironmentFile" $main
exit $LASTEXITCODE
