"""Copy only provider metadata into an isolated test workspace. No plaintext keys."""
import json
from pathlib import Path
from ice_agent.desktop_service import DesktopService
root=Path(__file__).resolve().parents[1];runtime=root/'.test-tmp'/'providers-v1';runtime.mkdir(parents=True,exist_ok=True)
source=json.loads((root/'.desktop-runtime'/'settings.json').read_text(encoding='utf-8'))
service=DesktopService(root,runtime,runtime/'articles')
try:
    for key in ('profiles','routes','vision'):
        if key in source:service.settings[key]=source[key]
    service.settings['max_model_calls']=16
    service.settings_file.write_text(json.dumps(service.settings,ensure_ascii=False,indent=2),encoding='utf-8')
finally:service.close()
local_state=root/'.desktop-runtime'/'electron'/'Local State'
if local_state.exists():
    encrypted_state=json.loads(local_state.read_text(encoding='utf-8')).get('os_crypt')
    if encrypted_state:
        target=runtime/'electron'/'Local State';target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps({'os_crypt':encrypted_state}),encoding='utf-8')
