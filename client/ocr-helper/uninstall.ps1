$ErrorActionPreference = 'Stop'
$TaskName = 'CourtHelper-OcrHelper'
$InstallRoot = Join-Path $env:LOCALAPPDATA 'CourtHelper\ocr-helper'
$PidFile = Join-Path $InstallRoot 'ocr-helper.pid'

& schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
if (Test-Path -LiteralPath $PidFile) {
    $processId = [int](Get-Content -LiteralPath $PidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($process -and $process.ExecutablePath -like "$InstallRoot*") {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

$resolved = [IO.Path]::GetFullPath($InstallRoot)
$expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CourtHelper\ocr-helper'))
if ($resolved -eq $expected -and (Test-Path -LiteralPath $resolved)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host 'court-helper OCR 助手已卸载。'
