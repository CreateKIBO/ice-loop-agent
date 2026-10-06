"""Create an explicitly isolated offline desktop chat fixture, never user data."""
import json
import sys
from dataclasses import asdict
from pathlib import Path

from ice_agent.desktop_service import DesktopService
from ice_agent.llm.capabilities import preset_profile
from ice_agent.llm.router import RouteConfig

root = Path(sys.argv[1]).resolve()
if root.exists() and any(root.iterdir()):
    raise SystemExit('fixture must use a new empty directory')
service = DesktopService(Path.cwd(), root)
account = service.call('bootstrap')['account']
library = root / 'library'
for issue in range(1, 5):
    folder = library / 'PY' / f'{issue:03d}-sample'
    folder.mkdir(parents=True)
    (folder / '01-公众号正文.md').write_text(f'# 示例：Python 第{issue}期\n\n这是隔离测试文章，不是用户原文。\n\n## 写在最后\n下一期继续做一个可运行的小作品。', encoding='utf-8')
service.call('accounts.save', {'account':{**account,'library_root':str(library)}})
service.call('history.progress', {'series':'PY','episode':4})
service.settings['profiles']['qwen'] = {**preset_profile('mock'), 'profile_id':'offline-chat-fixture'}
service.settings['routes']['writer'] = asdict(RouteConfig('offline-chat-fixture'))
service.settings_file.write_text(json.dumps(service.settings,ensure_ascii=False,indent=2),encoding='utf-8')
service.call('chat.create', {'series':'PY','title':'PY/005 · 标题与开头'})
service.close()
print(root)
