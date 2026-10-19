"""Full offline release baseline in the active workspace, with hang diagnostics."""
import faulthandler
import hashlib
import ipaddress
import json
import os
import socket
import sys
import time
import unittest
from importlib.metadata import version
from collections import Counter
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

repo = Path(__file__).resolve().parents[2]
out = Path(__file__).parent
def source_manifest():
    files = sorted({file for folder in ('ice_agent','tests','profiles')
        for file in (repo/folder).rglob('*') if file.is_file() and file.suffix in ('.py','.json')})
    files=sorted(set(files)|{repo/'pyproject.toml'})
    return {file.relative_to(repo).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in files}

started = time.monotonic()
source_before = source_manifest()
(out/'full-source-before.json').write_text(json.dumps(source_before,indent=2),encoding='utf-8')
runtime = repo/'.test-tmp/release-full'/uuid4().hex[:12]
runtime.mkdir(parents=True)
(runtime/'.test-owner.json').write_text('{"purpose":"full offline release baseline"}',encoding='utf-8')
os.environ['TEMP'] = os.environ['TMP'] = str(runtime)
for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):
    os.environ.pop(key,None)
sys.path.insert(0,str(repo))
import tests
tests.TEST_TMP = runtime

def flatten(suite):
    for case in suite:
        if isinstance(case,unittest.TestSuite): yield from flatten(case)
        else: yield case

suite = unittest.defaultTestLoader.discover(str(repo/'tests'),top_level_dir=str(repo))
ids = Counter(case.id() for case in flatten(suite))
collection = {'listed':sum(ids.values()),'unique':len(ids),'duplicates':{k:v for k,v in ids.items() if v>1}}
(out/'full-collection.json').write_text(json.dumps(collection,indent=2),encoding='utf-8')
if collection['duplicates']: raise SystemExit('Duplicate tests must be resolved before release counting')
connect = socket.socket.connect
connect_ex = socket.socket.connect_ex
def allowed(address):
    if not isinstance(address,tuple): return True
    host = address[0]
    if host == 'localhost': return True
    try: return ipaddress.ip_address(host).is_loopback
    except ValueError: return False
def local_connect(self,address):
    if not allowed(address): raise RuntimeError('External network disabled in release tests')
    return connect(self,address)
def local_connect_ex(self,address):
    if not allowed(address): raise RuntimeError('External network disabled in release tests')
    return connect_ex(self,address)

report_path = out/'full-tests.json'
report_path.write_text(json.dumps({'state':'running','total':len(ids),'runtime':str(runtime)}),encoding='utf-8')
with ((out/'full-tests.log').open('w',encoding='utf-8') as log,
      patch.object(socket.socket,'connect',local_connect), patch.object(socket.socket,'connect_ex',local_connect_ex)):
    class WatchedResult(unittest.TextTestResult):
        def startTest(self,test):
            faulthandler.dump_traceback_later(120,repeat=True,file=log)
            super().startTest(test)
        def stopTest(self,test):
            faulthandler.cancel_dump_traceback_later()
            super().stopTest(test)
            if self.testsRun%25==0:
                report_path.write_text(json.dumps({'state':'running','executed':self.testsRun,'total':len(ids),
                    'failures':len(self.failures),'errors':len(self.errors),'last':test.id()}),encoding='utf-8')
    result = unittest.TextTestRunner(stream=log,verbosity=2,resultclass=WatchedResult).run(suite)
source_after = source_manifest()
source_changes = sorted(file for file in source_before.keys()|source_after.keys()
                        if source_before.get(file) != source_after.get(file))
(out/'full-source-after.json').write_text(json.dumps(source_after,indent=2),encoding='utf-8')
report = {'state':'finished','tests':result.testsRun,'unique_collected':len(ids),'failures':len(result.failures),
          'errors':len(result.errors),'skipped':len(result.skipped),'success':result.wasSuccessful() and not source_changes,
          'elapsed_seconds':round(time.monotonic()-started,3),'source_changes':source_changes,
          'network':'loopback fixtures only; external connections blocked','runtime':str(runtime)}
report['runtime_dependencies']={name:version(name) for name in ('Pillow','pydantic','markdown-it-py','mdurl','httpx','httpcore','anyio','certifi')}
report_path.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
sys.exit(0 if report['success'] else 1)
