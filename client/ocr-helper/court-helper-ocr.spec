# PyInstaller specification for the customer OCR helper. Build on Windows x64.
import os
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = collect_all('ddddocr')

a = Analysis(
    [os.path.join(SPECPATH, '..', '..', 'scripts', 'login-helper-server.py')],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='court-helper-ocr', console=False)
coll = COLLECT(exe, a.binaries, a.datas, name='court-helper-ocr')
