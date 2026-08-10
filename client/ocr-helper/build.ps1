$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$buildRoot = Join-Path $root 'build\ocr-helper'
if (Test-Path $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
$venv = Join-Path $buildRoot '.venv'
py.exe -3.11 -m venv $venv
$python = Join-Path $venv 'Scripts\python.exe'
& $python -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt') 'pyinstaller==6.16.0'
& $python -m PyInstaller --noconfirm --clean --distpath (Join-Path $buildRoot 'dist') --workpath (Join-Path $buildRoot 'work') (Join-Path $PSScriptRoot 'court-helper-ocr.spec')
Write-Host (Join-Path $buildRoot 'dist\court-helper-ocr')
