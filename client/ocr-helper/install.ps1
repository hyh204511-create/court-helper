$ErrorActionPreference = 'Stop'
$TaskName = 'CourtHelper-OcrHelper'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'CourtHelper\ocr-helper'
$VenvPython = Join-Path $InstallRoot '.venv\Scripts\python.exe'

$launcher = Get-Command py.exe -ErrorAction SilentlyContinue
if (-not $launcher) { throw '请先安装 64 位 Python 3.11，并确保 py.exe 可用。' }
& $launcher.Source -3.11 -c "import sys; assert sys.version_info[:2] == (3, 11)"

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
} catch {
    $health = $null
}
if (-not $health -or $health.ok -ne $true) {
    $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw '127.0.0.1:8765 已被其他程序占用，请先释放端口。' }
}

try {
    Invoke-WebRequest -Uri 'https://pypi.org/simple/ddddocr/' -Method Head -UseBasicParsing -TimeoutSec 10 | Out-Null
} catch {
    throw '无法访问 Python 包源，请检查网络或代理后重试。'
}

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'login-helper-server.py') -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'requirements.txt') -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start.ps1') -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'health.ps1') -Destination $InstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination $InstallRoot -Force

& $launcher.Source -3.11 -m venv (Join-Path $InstallRoot '.venv')
& $VenvPython -m pip install --disable-pip-version-check --requirement (Join-Path $InstallRoot 'requirements.txt')

$startScript = Join-Path $InstallRoot 'start.ps1'
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
& schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $taskCommand /F | Out-Null
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript
Write-Host "OCR 助手已安装到 $InstallRoot，并注册当前用户登录后启动。"
