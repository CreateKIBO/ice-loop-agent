import gc,hashlib,json,sys,time,tracemalloc,types
from pathlib import Path
repo=Path(__file__).resolve().parents[2];sys.path.insert(0,str(repo))
from ice_agent.llm.transport import OpenAIChatTransport
baseline=Path(__file__).parent/'network-baseline-transport.py'
expected=json.loads((Path(__file__).parent/'generation-source-current.json').read_text())['current_feature_files']['ice_agent/llm/transport.py']
assert hashlib.sha256(baseline.read_bytes()).hexdigest()==expected
mode,base=sys.argv[1:]
if mode=='before':
    module=types.ModuleType('ice_agent.llm._network_accepted');module.__package__='ice_agent.llm';sys.modules[module.__name__]=module
    exec(compile(baseline.read_text(encoding='utf-8'),str(baseline),'exec'),module.__dict__)
    cls=module.OpenAIChatTransport
else:
    assert mode=='after';cls=OpenAIChatTransport
transport=cls(allow_loopback_http=True)
transport.chat(base+'/valid','fake-local-only','fixture',[{'role':'user','content':'test'}],stream=True)
gc.collect();tracemalloc.start();started=time.monotonic();code='unexpected-success'
try:transport.chat(base+'/large','fake-local-only','fixture',[{'role':'user','content':'test'}],stream=True)
except Exception as exc:code=getattr(exc,'code',type(exc).__name__)
current,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
print(json.dumps({'mode':mode,'python_traced_peak_bytes':peak,'python_traced_retained_bytes':current,'error_code':code,
                  'elapsed_ms':round((time.monotonic()-started)*1000,2),'baseline_sha256':expected,
                  'current_transport_sha256':hashlib.sha256((repo/'ice_agent/llm/transport.py').read_bytes()).hexdigest(),
                  'current_http_io_sha256':hashlib.sha256((repo/'ice_agent/llm/http_io.py').read_bytes()).hexdigest(),
                  'current_http_backend_sha256':hashlib.sha256((repo/'ice_agent/llm/http_backend.py').read_bytes()).hexdigest()}))
