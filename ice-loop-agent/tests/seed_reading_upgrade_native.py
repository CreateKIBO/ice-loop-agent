"""Fresh reading fixture, real offline service, historical candidates and brand assets."""
import json, runpy, sqlite3, sys
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
runpy.run_path(str(repo/'tests/seed_interaction_lists_native.py'))
f=json.loads((repo/'docs/上线准备/interaction-lists-fixture.json').read_text(encoding='utf-8'))
root=Path(f['root']);runtime=Path(f['runtime'])
assert root.parent==repo/'.test-tmp/release-interaction-lists' and (root/'.test-owner.json').is_file()
from ice_agent.domain.types import sha256_json
from ice_agent.desktop_service import DesktopService
body='# 候选阅读验收\n\n## 完整原文\n\n'+('连续长内容 '+ 'x'*160+'\n\n')*24+'- 列表项\n\n> 引用内容\n\n| 字段 | 含义 |\n| --- | --- |\n| 示例 | 完整 |\n\n```python\nprint("原文代码")\n```\n\n[链接](https://example.com)\n\n<script>window.__unsafeExecuted=true</script>\n'
title='键盘验收候选稿';digest=sha256_json({'title':title,'body':body})
with sqlite3.connect(runtime/'app.db') as db:
    db.execute('UPDATE publication_drafts SET body=?,content_hash=? WHERE draft_id=?',(body,digest,f['draft_id']))
    # Follow the existing fixture schema exactly; all candidates point to the same real base.
    base=json.dumps({'type':'draft','id':f['draft_id'],'content_hash':digest},ensure_ascii=False)
    db.execute('UPDATE creative_candidates SET body=?,base_json=? WHERE id=?',(body,base,f['candidate']))
    original=list(db.execute('SELECT * FROM creative_candidates WHERE id=?',(f['candidate'],)).fetchone())
    # 批E1（2026-10-25 候选对照轮）：跨页历史候选（触发分页 has_older）+ 两份同标题候选
    # （同名不同内容，供对照行身份区分）+ 含标题/代码/表格/长无空格串的对照正文。
    for index in range(6):
        row=original.copy();row[0]=f'reading-recent-{index}'
        row[3]='键盘验收候选稿' if index in (4,5) else f'较新候选 {index}'
        if index in (4,5):
            row[4]=body.replace('候选阅读验收','同题对照稿 '+str(index),1)
        else:
            row[4]='# 最近候选 '+str(index)+'\n\n- 项目\n\n```js\nconst x=1;\n```'
        row[10]=f'2026-10-25T00:00:0{index}Z'
        db.execute('INSERT INTO creative_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?)',row)
    # 对照正文：真标题/代码围栏伪标题/表格/长无空格串
    compare_body=('# 对照正文标题甲'+chr(10)+chr(10)+'## 数据表'+chr(10)+chr(10)+'| 列 | 值 |'+chr(10)+'| --- | --- |'+chr(10)+'| A | 1 |'+chr(10)+chr(10)+'~~~'+chr(10)+'# fence-not-heading'+chr(10)+'~~~'+chr(10)+chr(10)+'long-no-space:'+'z'*300+chr(10)+chr(10)+'## tail-section'+chr(10)+chr(10)+('padding section line '+chr(10)+chr(10))*60)
    db.execute('UPDATE creative_candidates SET body=? WHERE id=?',(compare_body,'reading-recent-4'))
    compare_body_b=compare_body.replace('对照正文标题甲','对照正文标题乙')
    db.execute('UPDATE creative_candidates SET body=? WHERE id=?',(compare_body_b,'reading-recent-5'))
    f['compare_candidates']=['reading-recent-4','reading-recent-5']
    f['compare_titles']=['键盘验收候选稿','键盘验收候选稿']
service=DesktopService(repo,runtime,root/'articles',auto_consumer=False)
try:
    service.call('resources.import_style',{'account_id':f['account_a']})
finally:service.close()
f['candidate_body']=body
(repo/'docs/上线准备/reading-upgrade-fixture.json').write_text(json.dumps(f,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'runtime':f['runtime'],'body_chars':len(body)}))
