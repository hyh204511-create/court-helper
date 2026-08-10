param([Parameter(Mandatory=$true)][string]$InstallRoot, [switch]$DeleteData)
$ErrorActionPreference = 'SilentlyContinue'
$wrapper = Join-Path $InstallRoot 'runtime\CourtHelperBackend.exe'
if (Test-Path $wrapper) { & $wrapper stop | Out-Null; & $wrapper uninstall | Out-Null }
Stop-Service CourtHelperPostgres -Force
sc.exe delete CourtHelperPostgres | Out-Null
if ($DeleteData) { Remove-Item -LiteralPath (Join-Path $env:ProgramData 'CourtHelper') -Recurse -Force }
