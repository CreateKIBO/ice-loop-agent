"""Archive actual acceptance results and approved-asset byte checks."""
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from ice_agent.genprompt import ICE_FILES, cover_prompt, body_diagram_prompt
DOCS=ROOT/'docs'


def asset_audit():
    original=ROOT.parent.parent/'output/ICE-Loop/视觉资产'
    bundled=ROOT/'ice_agent/resources/visual_presets/ice-loop'
    frozen=ROOT/'release/win-unpacked/resources/engine/_internal/ice_agent/resources/visual_presets/ice-loop'
    rows=[]
    for key,name in ICE_FILES.items():
        source=(original/name).read_bytes()
        packaged=(bundled/key).read_bytes()
        if source!=packaged:raise ValueError('Brand asset differs from approved original: '+name)
        if source!=(frozen/key).read_bytes():raise ValueError('Frozen brand asset differs from approved original: '+name)
        rows.append({'file':name,'bundled':key,'sha256':hashlib.sha256(source).hexdigest(),
                     'original_bytes_match':True,'frozen_engine_bytes_match':True})
    return rows


def examples():
    brand={'name':'ICE Loop','preset':'ice-loop','colors':['#2448DB','#15191F','#F3F2ED'],
           'image_style':'restrained flat editorial','visual_references':[]}
    cover=cover_prompt('AI',['什么是','vibe coding'],'AI / 001','',brand=brand)
    diagram=body_diagram_prompt('用嘴编程，怎么协作',
        ['你说需求','把想法讲清楚','AI 写代码','实现交给它','你验证','跑起来，改到位','不满意，重新说'],
        'Three horizontal stages from left to right with generous spacing: a small blue speech-bubble shape, '
        'a small blue code rectangle, and a small verification shape. Connect stages with thin blue forward arrows. '
        'Place headings above their supporting lines. Below them a return arrow runs from the third stage to the first, '
        'labelled only "不满意，重新说". Keep each arrow direction unambiguous.',brand=brand)
    (DOCS/'v1.5.1-提示词示例.md').write_text('# v1.5.1 配图提示词示例\n\n'
        '根据用户指定的 AI/001 提示词样式生成；示例题目固定用于对照，实际任务以当前文章标题与正文为准。\n\n'
        '## 封面编辑\n\n图片1：05-封面-AI-001.png。图片2：01-头像-信号蓝.png。\n\n```text\n'+cover+'\n```\n\n'
        '## 正文流程图\n\n图片1：01-头像-信号蓝.png，仅供风格参考。图片2：07-品牌视觉总览.png，仅供视觉体系参考。\n\n```text\n'
        +diagram+'\n```\n\n两张品牌身份资产为01头像、02横向字标；字标与头像保持原始文件，不把两种标志形态混合重绘。'
        '栏目封面使用现有03–06模板，正文图不放大品牌标志。生成结果仍需目视核对中文与标志形状。\n',encoding='utf-8')


if __name__=='__main__':
    examples()
    assets=asset_audit()
    results={}
    screenshots=DOCS/'screenshots/v1.5.1';screenshots.mkdir(parents=True,exist_ok=True)
    for name in ['browser-source','browser-packaged','prompt-source','prompt-packaged','chat-packaged']:
        path=DOCS/('v1.5.1-'+name+'.log')
        data=json.loads(path.read_text(encoding='utf-8'))
        flags={k:v for k,v in data.items() if isinstance(v,bool) and k!='packaged'}
        if not flags or not all(flags.values()):raise ValueError('Failed native acceptance: '+name)
        runtime=Path(data['runtime']).resolve()
        if not runtime.is_relative_to((ROOT/'.test-tmp').resolve()):raise ValueError('Nonisolated runtime')
        target=screenshots/name;target.mkdir(exist_ok=True)
        for image in runtime.glob('*.png'):shutil.copy2(image,target/image.name)
        results[name]={'passed':len(flags),'log':path.name,'result':data}
    node=(DOCS/'v1.5.1-node-tests.log').read_text(encoding='utf-8')
    py=(DOCS/'v1.5.1-python-final.log').read_text(encoding='utf-8')
    count=re.search(r'Ran (\d+) tests',py)
    if not count or not py.rstrip().endswith('OK'):raise ValueError('Python acceptance failed')
    store_tests=(DOCS/'v1.5.1-store-tests.log').read_text(encoding='utf-8')
    store_count=re.search(r'Ran (\d+) tests',store_tests)
    if not store_count or not store_tests.rstrip().endswith('OK'):raise ValueError('Store acceptance failed')
    passed=re.search(r'(?:ℹ|#) pass (\d+)',node)
    if not passed or not re.search(r'(?:ℹ|#) fail 0',node):raise ValueError('Node acceptance failed')
    audits={}
    for name in ['source','binary']:
        source=ROOT/'.test-tmp'/('release-'+name+'-check.json')
        audits[name]=json.loads(source.read_text(encoding='utf-8'))
        if audits[name]['version']!='1.5.1':raise ValueError('Release version mismatch')
        shutil.copy2(source,DOCS/('v1.5.1-package-'+name+'-audit.json'))
    for file in audits['binary']['files']:
        actual=ROOT/'release'/file['name']
        with actual.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
        if actual.stat().st_size!=file['bytes'] or digest!=file['sha256']:raise ValueError('Release changed after audit')
    result={'version':'1.5.1','recorded_at':datetime.now(timezone(timedelta(hours=8), 'Asia/Shanghai')).isoformat(),
        'python':{'passed':int(count[1]),'log':'v1.5.1-python-final.log'},
        'store_regression':{'passed':int(store_count[1]),'log':'v1.5.1-store-tests.log'},
        'node':{'passed':int(passed[1]),'log':'v1.5.1-node-tests.log'},
        'native':results,'approved_assets':assets,'package_audits':audits,
        'boundaries':{'isolated_data':True,'offline_models':True,'paid_models_called':False,
                      'real_cloud_generation_tested':False,'published':False,'actual_upgrade_installation_executed':False},
        'screenshots':str(screenshots.relative_to(ROOT)),
        'note':'Source browser/prompt UI runs preceded the later database read-connection fix; final packaged runs use the rebuilt engine. '
               'Browser parent screenshots exclude the separate native webpage view. embedded-view.png records the fixture itself. '
               'Cloud generation quality has not been tested with a paid model or actual TapNow generation.'}
    (DOCS/'v1.5.1-验收结果.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'version':'1.5.1','python':int(count[1]),'node':int(passed[1]),
        'native':{name:value['passed'] for name,value in results.items()},'approved_assets':len(assets)},ensure_ascii=False))
