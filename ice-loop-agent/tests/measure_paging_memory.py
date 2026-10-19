"""Fresh-process allocation evidence against the saved pre-change implementation."""
import hashlib
import json
import os
import sys
import time
import tracemalloc
import types
from pathlib import Path

repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo))
from ice_agent.domain.store import Store
from ice_agent.editorial_topics import EditorialTopics,example
from ice_agent.publication_history import PublicationHistory

fixture=json.loads((repo/'docs/上线准备/paging-fixture.json').read_text(encoding='utf-8'))
root=Path(fixture['root']);runtime=Path(fixture['runtime'])
assert root.parent==repo/'.test-tmp/release-paging' and json.loads((root/'.test-owner.json').read_text())['purpose']=='editorial paging and history memory acceptance'
os.environ['TEMP']=os.environ['TMP']=str(runtime)
settings=json.loads((runtime/'settings.json').read_text(encoding='utf-8'));account=settings['accounts'][fixture['account_id']]
baseline=repo/'docs/上线准备/paging-baseline-publication-history.py'
before=types.ModuleType('ice_agent._paging_reference');before.__package__='ice_agent'
exec(compile(baseline.read_text(encoding='utf-8'),str(baseline),'exec'),before.__dict__)
mode=sys.argv[1]
if mode not in ('history-before','history-after','history-summary','topics-before','topics-after'):
    raise SystemExit('Unsupported measure mode')
store=Store(runtime/'app.db')
try:
    tracemalloc.start();start=time.perf_counter()
    if mode=='history-before':result=before.PublicationHistory(store,account).context('OBS',1491)
    elif mode=='history-after':result=PublicationHistory(store,account).context('OBS',1491)
    elif mode=='history-summary':result=PublicationHistory(store,account).context('OBS',1491,include_titles=False)
    elif mode=='topics-before':result={'rows':EditorialTopics(store,account).list(),'example':example(account)}
    else:result=EditorialTopics(store,account).page({'series':'OBS','page_size':10,'page':0})
    encoded=json.dumps(result,ensure_ascii=False,sort_keys=True).encode('utf-8')
    elapsed=time.perf_counter()-start;retained,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
    print(json.dumps({'mode':mode,'elapsed_ms':round(elapsed*1000,2),'python_traced_peak_bytes':peak,
        'python_traced_retained_bytes':retained,'serialized_bytes':len(encoded),'result_hash':hashlib.sha256(encoded).hexdigest(),
        'context_hash':result.get('context_hash'),'titles':len(result.get('known_titles',[])),
        'history':len(result.get('history',[])),'rows':len(result.get('rows',[])),
        'baseline_sha256':hashlib.sha256(baseline.read_bytes()).hexdigest()}))
finally:store.close()
