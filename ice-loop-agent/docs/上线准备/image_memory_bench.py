"""Two fresh owned processes compare the previous decoder with the bounded decoder."""
import base64
import ctypes
import gc
import hashlib
import io
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

repo=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(repo))
from PIL import Image,ImageOps
from ice_agent.image_memory import thumbnail_data_url


def memory():
    class Counters(ctypes.Structure):
        _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(key,ctypes.c_size_t) for key in (
            'PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage',
            'QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage')]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.GetCurrentProcess.restype=ctypes.c_void_p
    psapi=ctypes.WinDLL('psapi',use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong]
    result=Counters();result.cb=ctypes.sizeof(result)
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(result),result.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return {'working_set':result.WorkingSetSize,'private':result.PrivateUsage}


def previous_thumbnail(file):
    # Exact former preview pixel path; never modifies production source or user files.
    with Image.open(file) as source:
        image=ImageOps.exif_transpose(source).convert('RGBA')
        image.thumbnail((1000,700))
        output=io.BytesIO();image.save(output,format='PNG')
    return 'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode('ascii')


if '--case' in sys.argv:
    case=sys.argv[sys.argv.index('--case')+1];file=Path(sys.argv[-1]).resolve()
    if file.name!='source.png' or not file.is_relative_to(repo/'.test-tmp/release-image-memory'):
        raise SystemExit('Only the owned image-memory fixture is allowed')
    before=memory();peak=dict(before);closed=threading.Event()
    def sample():
        while not closed.wait(.005):
            current=memory()
            for key in peak:peak[key]=max(peak[key],current[key])
    monitor=threading.Thread(target=sample,daemon=True);monitor.start()
    barrier=threading.Barrier(6)
    def read(_):
        barrier.wait(10)
        result=(previous_thumbnail if case=='previous' else thumbnail_data_url)(file)
        return hashlib.sha256(result.encode()).hexdigest()
    started=time.monotonic()
    try:
        with ThreadPoolExecutor(max_workers=6) as pool:hashes=list(pool.map(read,range(6)))
        gc.collect();time.sleep(.1)
    finally:closed.set();monitor.join(2)
    print(json.dumps({'case':case,'requests':6,'image_pixels':[2400,1800],'before':before,'peak':peak,'after':memory(),
        'duration_ms':int((time.monotonic()-started)*1000),'hashes':hashes}))
else:
    runtime=repo/'.test-tmp/release-image-memory'/uuid4().hex[:12];runtime.mkdir(parents=True)
    (runtime/'.test-owner.json').write_text('{"purpose":"owned image decoder memory comparison"}',encoding='utf-8')
    file=runtime/'source.png'
    with Image.new('RGB',(2400,1800),'#2448db') as source:source.save(file)
    env={**os.environ,'TEMP':str(runtime),'TMP':str(runtime),'PYTHONUTF8':'1'}
    for key in ('DASHSCOPE_API_KEY','DEEPSEEK_API_KEY','MOONSHOT_API_KEY','BIGMODEL_API_KEY','ARK_API_KEY','MINIMAX_API_KEY'):env.pop(key,None)
    results=[]
    for case in ('previous','bounded'):
        child=subprocess.run([sys.executable,'-X','utf8','-B',__file__,'--case',case,str(file)],cwd=repo,env=env,
            capture_output=True,text=True,encoding='utf-8',timeout=60)
        if child.returncode:raise RuntimeError(child.stderr[-1000:])
        results.append(json.loads(child.stdout))
    identical=len({value for result in results for value in result['hashes']})==1
    report={'success':identical,'runtime':str(runtime),'results':results,'identical_outputs':identical,
        'scope':'six 4.32MP thumbnails in fresh Python processes; not whole desktop RAM or 40MP worst-case'}
    out=Path(__file__).parent/'image-memory-bench.json';out.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))
    if not identical:raise SystemExit(1)
