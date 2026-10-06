"""Explicit, idempotent import of the user's approved ICE Loop visual assets."""
from pathlib import Path
import hashlib

from .workspace_assets import WorkspaceAssets

ASSETS = [
    ('avatar.png','正式头像 · ICE Loop','reference','Approved identity asset. Keep unchanged; do not redraw the double-O interwoven wordmark.'),
    ('wordmark.png','透明字标 · ICE Loop','reference','Approved transparent identity asset; reuse unchanged.'),
    ('cover-py.png','PY 栏目封面模板','cover','PY: warm-white background, signal-blue identity, left-aligned large title. Change only title and episode.'),
    ('cover-jv.png','JV 栏目封面模板','cover','JV: ink-black background, warm-white identity and blue short rules. Change only title and episode.'),
    ('cover-ai.png','AI 栏目封面模板','cover','AI: warm-white background, blue identity, sparse step markers. Change only title and episode.'),
    ('cover-wk.png','WK 栏目封面模板','cover','WK: signal-blue background, warm-white identity and tidy numbering. Change only title and episode.'),
    ('overview.png','ICE Loop 品牌视觉总览','reference','Visual system reference: blue, black, warm white; flat editorial grid, generous whitespace, fine rules and mono-style labels.'),
]


def import_ice_style(store, runtime: Path, account: dict, params: dict) -> dict:
    if account.get('preset')!='ice-loop' or account['id']!=params.get('account_id'):
        raise ValueError('此风格包仅用于当前ICE Loop档案；其他公众号请导入自己的参考图')
    box=WorkspaceAssets(store,runtime,account['id']);existing=box.resources()
    root=Path(__file__).parent/'resources'/'visual_presets'/'ice-loop'
    files=[root/entry[0] for entry in ASSETS]
    if not all(p.is_file() for p in files):raise ValueError('安装包中缺少视觉风格资产，请重新安装完整版本')
    hashes=[hashlib.sha256(p.read_bytes()).hexdigest() for p in files]
    if len(set(hashes)|{r['sha256'] for r in existing if r.get('style_reference')})>8:
        raise ValueError('导入后风格参考将超过8张，请先取消其他图片的风格参考标记')
    rows=[]
    for entry,file,digest in zip(ASSETS,files,hashes):
        row=next((r for r in existing if r['sha256']==digest),None)
        if row is None:
            row=box.import_image(file)
            row.update(title=entry[1],usage=entry[2],description=entry[3],tags=['ICE Loop','品牌风格'])
        row.update(style_reference=True,preset_asset=entry[0])
        box.save_resource(row);rows.append(box.resource(row['resource_id']))
    return {'resources':rows,'imported':len(rows),'mode':'reference_only'}
