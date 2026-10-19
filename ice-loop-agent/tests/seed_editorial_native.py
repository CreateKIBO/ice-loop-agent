"""General publication roadmap: 70 full articles, editable DOCX, explicit offline model."""
import json
import os
import sys
import zipfile
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import new_id,now_iso
from ice_agent.llm.capabilities import preset_profile
from ice_agent.paths import atomic_write_text

root=repo/'.test-tmp/release-editorial'/uuid4().hex[:12]
runtime=root/'runtime';runtime.mkdir(parents=True)
atomic_write_text(root/'.test-owner.json','{"purpose":"editorial roadmap native acceptance"}')
os.environ['TEMP']=os.environ['TMP']=str(runtime)
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    first=service._account();service.accounts_save({'account':{**first,'library_root':''}})
    account={k:v for k,v in first.items() if k!='id'}
    account.update(preset='general',name='纸间观察',audience='日常观察与动手实践的读者',library_root='',
        article_root=str(root/'observations'),columns=[{'code':'OBS','name':'观察手记'},{'code':'LAB','name':'实践记录'}],brand_document='只陈述有依据的事实。')
    aid=service.accounts_save({'account':account})['saved_account_id']
    _,_,store=service._app()
    try:
        for issue in range(1,71):
            store.conn.execute('INSERT INTO publication_history VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                (new_id('history'),aid,f'editorial-fixture:{issue}','OBS',issue,f'观察历史标题{issue:03}',
                 f'# 观察历史标题{issue:03}\n\n完整正文{issue}。\n\n## 写在最后\n下期继续观察。\n',
                 'published' if issue<=10 else 'draft','2026-10-01' if issue<=10 else '',1,now_iso()))
        store.conn.commit()
    finally:store.close()
    profile=preset_profile('mock',profile_id='editorial-offline-fixture')
    profile.update(api_key_env='ICE_EDITORIAL_FAKE_KEY',status='verified',model_id='offline-editorial-draft')
    service.settings['profiles']={'offline':profile}
    for route in service.settings['routes'].values():route.update(primary=profile['profile_id'],fallbacks=[])
    atomic_write_text(service.settings_file,json.dumps(service.settings,ensure_ascii=False,indent=2))
    text='## OBS · 观察手记\n'+''.join(f'### 第{issue:03}期：预设观察题目{issue}\n内容要点：观察第{issue}期的具体问题。\n读者收益：完成一次观察记录。\n' for issue in range(11,36))+'### 第100期：回看第一百次观察\n'
    document=root/'观察排期.docx'
    from xml.sax.saxutils import escape
    xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+''.join('<w:p><w:r><w:t>'+escape(line)+'</w:t></w:r></w:p>' for line in text.splitlines())+'</w:body></w:document>'
    with zipfile.ZipFile(document,'w') as archive:archive.writestr('word/document.xml',xml)
    wrapper=root/'editorial-main.cjs'
    atomic_write_text(wrapper,"""'use strict';
process.env.ICE_EDITORIAL_FAKE_KEY='fixture-only-never-a-real-key';
const {dialog}=require('electron');dialog.showOpenDialog=async()=>({canceled:false,filePaths:[DOCUMENT]});
require(MAIN);
""".replace('DOCUMENT',json.dumps(str(document))).replace('MAIN',json.dumps(str(repo/'desktop/main.cjs'))))
    fixture={'root':str(root),'runtime':str(runtime),'entry':str(wrapper),'account_id':aid,'document':str(document),
             'expected_topics':26,'offline_model':True,'os_file_dialog_injected':True}
    atomic_write_text(repo/'docs/上线准备/editorial-fixture.json',json.dumps(fixture,ensure_ascii=False,indent=2))
    print(json.dumps(fixture,ensure_ascii=False))
finally:service.close()
