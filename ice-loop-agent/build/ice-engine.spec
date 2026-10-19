# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = []
datas += collect_data_files('ice_agent')
datas += collect_data_files('pydantic')
datas += collect_data_files('certifi')


a = Analysis(
    ['engine_entry.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=collect_submodules('markdown_it')+collect_submodules('mdurl')+collect_submodules('httpx')+collect_submodules('httpcore')+collect_submodules('anyio'),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ice-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ice-engine',
)
