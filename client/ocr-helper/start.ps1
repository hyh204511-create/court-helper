$ErrorActionPreference = 'Stop'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'CourtHelper\ocr-helper'
$PythonExe = Join-Path $InstallRoot '.venv\Scripts\pythonw.exe'
$HelperScript = Join-Path $InstallRoot 'login-helper-server.py'
$PidFile = Join-Path $InstallRoot 'ocr-helper.pid'

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
    if ($health.ok -eq $true) { exit 0 }
} catch { }

if (-not (Test-Path -LiteralPath $PythonExe) -or -not (Test-Path -LiteralPath $HelperScript)) {
    throw 'OCR 助手尚未安装，请先运行 install.ps1。'
}

$process = Start-Process -FilePath $PythonExe -ArgumentList @($HelperScript, '--ocr-only', '--port', '8765') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii
Start-Sleep -Seconds 2
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 3
if ($health.ok -ne $true) { throw 'OCR 助手启动后健康检查失败。' }
