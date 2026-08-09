$ErrorActionPreference = 'Stop'
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 3
    if ($health.ok -eq $true) {
        Write-Host 'OCR 助手运行正常：127.0.0.1:8765'
        exit 0
    }
} catch { }
Write-Error 'OCR 助手不可用，请运行 start.ps1 或重新安装。'
exit 1
