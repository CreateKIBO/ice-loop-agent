"""G-only synthetic conversations; no model requests or article code execution."""
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from ice_agent.desktop_service import DesktopService
from ice_agent.domain.types import new_id, now_iso

runtime = repo / '.test-tmp' / 'interaction-20261015' / ('native-' + uuid4().hex[:10])
runtime.mkdir(parents=True)
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
runtime.joinpath('.test-owner.json').write_text('{"purpose":"interaction acceptance 2026-10-15"}', encoding='utf-8')
body = '# 阅读示例\n\n**清楚表达**，再讨论 `变量`。\n\n- 读者问题\n- 写作方向\n\n```python\nprint("ICE Loop")\n```\n\n| 主题 | 下一步 |\n| --- | --- |\n| 教程 | 审阅 |\n\n<script>window.__UX_INJECTED=true</script>\n\n![图片](https://example.com/pixel.png)\n'
service = DesktopService(repo, runtime, runtime / 'articles')
try:
    first = service.call('chat.create', {'title':'交互验收会话'})['conversation']['id']
    second = service.call('chat.create', {'title':'第二个验收会话'})['conversation']['id']
    draft = service.call('drafts.save', {'title':'原生草稿预览', 'body':body})
    _, _, store = service._app(demo=True)
    try:
        for i in range(16):
            store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
                (new_id('message'), first, 'assistant', body + '\n第 ' + str(i+1) + ' 轮讨论\n', 'completed', '{}', now_iso()))
        store.conn.execute('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',
            (new_id('message'), first, 'user', '保留这个问题，继续讨论。', 'completed', '{}', now_iso()))
        store.conn.commit()
    finally:
        store.close()
    fixture = {'runtime':str(runtime),'conversation':first,'second':second,'draft_id':draft['draft_id']}
    output = repo / 'docs' / '交互迭代-2026-10-15'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'native-fixture.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(fixture,ensure_ascii=False))
finally:
    service.close()
