$ErrorActionPreference = 'SilentlyContinue'
$checks = @(
  @{ Name='后台'; Url='http://127.0.0.1:3000/health' },
  @{ Name='OCR'; Url='http://127.0.0.1:8765/health' }
)
foreach ($check in $checks) {
  try { $r=Invoke-RestMethod $check.Url -TimeoutSec 3; Write-Host "[OK] $($check.Name)" } catch { Write-Host "[FAIL] $($check.Name) - 请重启服务或联系管理员" }
}
Get-Service CourtHelperPostgres,CourtHelperBackend | Select-Object Name,Status,StartType | Format-Table
