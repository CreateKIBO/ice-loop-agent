"""UTF-8 startup-only progress/cancellation; no model or normal RPC access."""
import json
import re
import sys
import time
from pathlib import Path
from .paths import normalize, assert_not_c_drive

class StartupCancelled(Exception):
    pass

class StartupProgress:
    def __init__(self, runtime, session):
        if not isinstance(session, str) or not re.fullmatch(r'[0-9a-f]{32}', session):
            raise ValueError('启动会话标识无效')
        self.runtime = normalize(runtime)
        assert_not_c_drive(self.runtime)
        self.file = self.runtime/'startup-control'/('cancel-'+session)
        self.last_at = 0
        self.phase = None
        self.closed = False

    def __call__(self, phase, **values):
        if self.closed:
            return
        # Cancellation is only allowed before live database migration begins.
        if self.file.exists() and self.phase not in ('upgrade_database','initialize_workspace'):
            raise StartupCancelled('启动已取消，原资料保留')
        now = time.monotonic()
        if phase != self.phase or now-self.last_at >= 0.25:
            self.phase, self.last_at = phase, now
            value = {'kind':'startup.progress','phase':phase,'cancelable':phase not in ('upgrade_database','initialize_workspace','ready')}
            value.update({key:item for key,item in values.items() if isinstance(item,(int,float)) and not isinstance(item,bool)})
            sys.stdout.buffer.write(json.dumps(value,ensure_ascii=False).encode('utf-8')+b'\n')
            sys.stdout.buffer.flush()

    def fail(self, error):
        import sqlite3
        text = str(error) if isinstance(error,(ValueError,OSError,sqlite3.Error,StartupCancelled)) else '工作区准备失败，请通过启动恢复入口检查资料'
        sys.stdout.buffer.write(json.dumps({'kind':'startup.error','message':text[:1500]},ensure_ascii=False).encode('utf-8')+b'\n')
        sys.stdout.buffer.flush()

    def close(self):
        self.closed = True
        try:
            self.file.unlink(missing_ok=True)
        except OSError:
            pass
