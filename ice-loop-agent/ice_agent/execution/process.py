"""Bounded process execution. Child stdin never inherits the engine's RPC stream."""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time

OUTPUT_LIMIT = 2 * 1024 * 1024  # combined stdout/stderr, per execution stage


class WindowsTree:
    """Assign a suspended child to a private kill-on-close Job before it can fork."""
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        self.c = c
        self.k = c.WinDLL('kernel32', use_last_error=True)

        class Basic(c.Structure):
            _fields_ = [('PerProcessUserTimeLimit', c.c_int64), ('PerJobUserTimeLimit', c.c_int64),
                        ('LimitFlags', w.DWORD), ('MinimumWorkingSetSize', c.c_size_t),
                        ('MaximumWorkingSetSize', c.c_size_t), ('ActiveProcessLimit', w.DWORD),
                        ('Affinity', c.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]
        class IO(c.Structure):
            _fields_ = [(name, c.c_uint64) for name in ('ReadOperationCount', 'WriteOperationCount',
                'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]
        class Extended(c.Structure):
            _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', IO), ('ProcessMemoryLimit', c.c_size_t),
                        ('JobMemoryLimit', c.c_size_t), ('PeakProcessMemoryUsed', c.c_size_t), ('PeakJobMemoryUsed', c.c_size_t)]
        self.k.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
        self.k.CreateJobObjectW.restype = w.HANDLE
        self.k.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        self.k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.k.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.k.CreateJobObjectW(None, None)
        if not self.handle:
            raise c.WinError(c.get_last_error())
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.k.SetInformationJobObject(self.handle, 9, c.byref(limits), c.sizeof(limits)):
            error = c.WinError(c.get_last_error())
            self.close()
            raise error

    def attach(self, proc):
        from ctypes import wintypes as w
        c, k = self.c, self.k
        if not k.AssignProcessToJobObject(self.handle, w.HANDLE(int(proc._handle))):
            raise c.WinError(c.get_last_error())
        # Popen closes the primary-thread handle; reopen the suspended child's
        # thread using the documented ToolHelp API, then resume it exactly once.
        class Thread(c.Structure):
            _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ThreadID', w.DWORD),
                        ('th32OwnerProcessID', w.DWORD), ('tpBasePri', w.LONG), ('tpDeltaPri', w.LONG), ('dwFlags', w.DWORD)]
        k.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
        k.CreateToolhelp32Snapshot.restype = w.HANDLE
        k.Thread32First.argtypes = [w.HANDLE, c.POINTER(Thread)]
        k.Thread32Next.argtypes = [w.HANDLE, c.POINTER(Thread)]
        k.OpenThread.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        k.OpenThread.restype = w.HANDLE
        k.ResumeThread.argtypes = [w.HANDLE]
        k.ResumeThread.restype = w.DWORD
        snapshot = k.CreateToolhelp32Snapshot(4, 0)
        if snapshot == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
        try:
            entry = Thread()
            entry.dwSize = c.sizeof(entry)
            found = k.Thread32First(snapshot, c.byref(entry))
            while found:
                if entry.th32OwnerProcessID == proc.pid:
                    thread = k.OpenThread(2, False, entry.th32ThreadID)
                    if not thread:
                        raise c.WinError(c.get_last_error())
                    try:
                        if k.ResumeThread(thread) == 0xffffffff:
                            raise c.WinError(c.get_last_error())
                    finally:
                        k.CloseHandle(thread)
                    return
                found = k.Thread32Next(snapshot, c.byref(entry))
            raise RuntimeError('无法恢复教学程序的独立线程')
        finally:
            k.CloseHandle(snapshot)

    def terminate(self):
        if self.handle:
            self.k.TerminateJobObject(self.handle, 1)

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle)
            self.handle = None


def execute_bounded(argv, *, cwd, env, stdin=b'', timeout=30, output_limit=OUTPUT_LIMIT):
    """Return CompletedProcess + timeout/limit flags; reap owned tree on every exit."""
    tree = WindowsTree() if os.name == 'nt' else None
    proc = None
    buffers = [bytearray(), bytearray()]
    lock = threading.Lock()
    exceeded = threading.Event()
    readers = []
    writer = None
    started = time.monotonic()

    def stop():
        if tree:
            tree.terminate()
        elif proc:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def read(pipe, index):
        try:
            while chunk := pipe.read(8192):
                with lock:
                    room = max(0, output_limit - sum(map(len, buffers)))
                    buffers[index].extend(chunk[:room])
                    if len(chunk) > room:
                        exceeded.set()
                        stop()
                        break
        finally:
            pipe.close()

    def write():
        try:
            proc.stdin.write(stdin)
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            proc.stdin.close()

    try:
        proc = subprocess.Popen(argv, cwd=str(cwd), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=(subprocess.CREATE_NO_WINDOW | 4) if tree else 0,
            start_new_session=not bool(tree))
        if tree:
            tree.attach(proc)
        readers = [threading.Thread(target=read, args=(pipe, i), daemon=True)
                   for i, pipe in enumerate((proc.stdout, proc.stderr))]
        for reader in readers:
            reader.start()
        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        timed_out = False
        while proc.poll() is None:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                timed_out = True
                stop()
                break
            try:
                proc.wait(timeout=min(remaining, 0.05))
            except subprocess.TimeoutExpired:
                pass
        stop()  # successful parents must not leave background children behind
        proc.wait(timeout=5)
        for thread in [*readers, writer]:
            thread.join(timeout=5)
        return (subprocess.CompletedProcess(argv, proc.returncode, bytes(buffers[0]), bytes(buffers[1])),
                timed_out, exceeded.is_set())
    finally:
        stop()
        if proc:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=5)
            for thread in [*readers, writer]:
                if thread:
                    thread.join(timeout=5)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe and not pipe.closed:
                    pipe.close()
        if tree:
            tree.close()
