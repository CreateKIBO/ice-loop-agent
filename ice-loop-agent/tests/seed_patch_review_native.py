"""Fresh owned interaction fixture plus real multi-operation editorial proposals."""
from pathlib import Path
import json,runpy,sys
repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
runpy.run_path(str(repo/'tests/seed_interaction_lists_native.py'),run_name='__main__')
from ice_agent.desktop_service import DesktopService
from ice_agent.editorial import block_hashes
pointer=repo/'docs/上线准备/interaction-lists-fixture.json'
f=json.loads(pointer.read_text(encoding='utf-8'));root=Path(f['root'])
service=DesktopService(repo,Path(f['runtime']),root/'articles',auto_consumer=False)
try:
 job=f['jobs']['completed'];doc=service.call('articles.document',{'job_id':job})
 body='# 审阅性能夹具\n\n'+'\n\n'.join(f'原段落{i}。'+ '甲'*2400 for i in range(40))
 service.call('articles.save',{'job_id':job,'body':body,'content_hash':doc['content_hash']})
 doc=service.call('articles.document',{'job_id':job});hashes=block_hashes(doc['document'])
 blocks=[b for b in doc['document']['blocks'] if b['type']=='paragraph']
 ops=[{'op':'replace','block_id':b['block_id'],'old_hash':hashes[b['block_id']],'text':f'修改段落{i}。'+'乙'*2400} for i,b in enumerate(blocks)]
 if '--paged' in sys.argv or 'proposal-pages' in sys.argv:
  for i in range(23):
   service.call('articles.propose_patch',{'job_id':job,'base_revision':'current','ops':ops[:1],'reason':f'分页提案{i}'})
 bulk=service.call('articles.propose_patch',{'job_id':job,'base_revision':'current','ops':ops,'reason':'批量40项对比'})['proposal']
 other=service.call('articles.propose_patch',{'job_id':job,'base_revision':'current','ops':ops[:1],'reason':'另一份提案'})['proposal']
 if '--paged' in sys.argv or 'proposal-pages' in sys.argv:
  _,_,store=service._job_app(job)
  try:
   store.conn.execute("UPDATE edit_proposals SET created_at=? WHERE article_id=?",('2026-10-23T00:00:00',bulk['article_id']))
   store.conn.execute("UPDATE edit_proposals SET created_at=? WHERE proposal_id=?",('2026-10-23T00:00:02',bulk['proposal_id']))
   store.conn.execute("UPDATE edit_proposals SET created_at=? WHERE proposal_id=?",('2026-10-23T00:00:01',other['proposal_id']))
   store.conn.commit()
  finally:store.close()
  legacy=service.call('articles.proposals_list',{'job_id':job})
  page=service.call('articles.proposals_page',{'job_id':job})
  (root/'page-payload.json').write_text(json.dumps({'legacy_bytes':len(json.dumps(legacy,ensure_ascii=False).encode()),'page_bytes':len(json.dumps(page,ensure_ascii=False).encode()),'total_fixture_proposals':len(legacy['proposals']),'page_count':len(page['proposals'])}),encoding='utf-8')
 f.update(patch_job=job,bulk_proposal=bulk['proposal_id'],other_proposal=other['proposal_id'],original_body=body)
 (repo/'docs/上线准备/patch-review-fixture.json').write_text(json.dumps(f,ensure_ascii=False),encoding='utf-8')
 print(json.dumps({'patch_fixture':str(root),'ops':len(ops)}))
finally:service.close()
