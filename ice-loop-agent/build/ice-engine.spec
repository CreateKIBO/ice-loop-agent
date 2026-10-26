# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules
project_root = Path(SPECPATH).resolve().parent
cache_excludes = ["**/__pycache__/**", "**/*.pyc", "**/*.pyo"]

datas = []
datas += collect_data_files('ice_agent', excludes=cache_excludes)
datas += collect_data_files('pydantic', excludes=cache_excludes)
datas += collect_data_files('certifi', excludes=cache_excludes)


a = Analysis(
    [str(project_root / 'build' / 'engine_entry.py')],
    pathex=[str(project_root)],
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
    upx=False,
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
    upx=False,
    upx_exclude=[],
    name='ice-engine',
)
