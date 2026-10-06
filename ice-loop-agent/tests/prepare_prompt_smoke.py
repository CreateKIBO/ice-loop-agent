"""Create a controlled offline job; no real account, secrets or paid requests."""
import json
import sys
from pathlib import Path

from ice_agent.desktop_service import DesktopService
from tests import REPO
from tests.test_workflow import demo_spec

runtime=Path(sys.argv[1]).resolve()
service=DesktopService(REPO,runtime,runtime/'articles')
try:
    engine,_,store=service._app(demo=True)
    try:
        spec=demo_spec();spec.update(account_id='ice-loop',demo=True,production_mode='auto_prepare',
            account_snapshot=service._account(),article_root=str(runtime/'articles'))
        job,article=engine.create_job(spec);result=engine.run(job)
        if result['state']!='completed':raise RuntimeError(result)
        from ice_agent.supplements import create
        original=runtime/'original.md'
        original.write_text('# PY / 007 离线补图测试\n\n原稿不能自动改写。\n\n![图1：封面](待配图：生图)\n',encoding='utf-8')
        supplement=create(engine,store,service._account(),original)['job_id']
        limits=store.get_job(supplement)['limits'];limits.pop('max_image_model_calls',None)
        store.conn.execute('UPDATE jobs SET limits_json=? WHERE job_id=?',(json.dumps(limits),supplement));store.conn.commit()
        (runtime/'prompt-fixture.json').write_text(json.dumps({'job_id':job,'supplement_job_id':supplement},ensure_ascii=False),encoding='utf-8')
    finally:store.close()
finally:service.close()
