import ctypes as ct
from ctypes import wintypes as wt
import threading
import unittest
import os
from PIL import Image
from ice_agent.native_capture import api,windows,capture
from tests import temp_dir

@unittest.skipUnless(os.name=='nt','Win32 only')
class TestActualNativeCapture(unittest.TestCase):
    def test_real_selected_window_and_stale_target(self):
        ready=threading.Event();state={}
        def fixture():
            user,kernel,_=api()
            user.CreateWindowExW.restype=wt.HWND
            user.CreateWindowExW.argtypes=[wt.DWORD,wt.LPCWSTR,wt.LPCWSTR,wt.DWORD,ct.c_int,ct.c_int,ct.c_int,ct.c_int,wt.HWND,wt.HMENU,wt.HINSTANCE,wt.LPVOID]
            hwnd=user.CreateWindowExW(0,'STATIC','ICE Native Capture Regression - actual pixels',0x10CF0000,-2500,50,1000,600,None,None,None,None)
            state['hwnd']=hwnd;state['user']=user;ready.set()
            if hwnd:
                message=wt.MSG()
                while user.GetMessageW(ct.byref(message),None,0,0)>0:user.TranslateMessage(ct.byref(message));user.DispatchMessageW(ct.byref(message))
        thread=threading.Thread(target=fixture,daemon=True);thread.start();self.assertTrue(ready.wait(10));hwnd=state['hwnd'];self.assertTrue(hwnd)
        try:
            row=next(r for r in windows() if r['hwnd']==hwnd)
            path,meta=capture({'hwnd':hwnd,'fingerprint':row['fingerprint']},temp_dir('native-capture-'))
            self.assertEqual(meta['capture_mode'],'native_window');self.assertGreater(path.stat().st_size,1000)
            with Image.open(path) as image:self.assertEqual(list(image.size),meta['physical_size'])
            self.assertGreaterEqual(meta['physical_size'][0],1000)
            self.assertEqual(meta['physical_size'],[meta['window_rect'][2]-meta['window_rect'][0],meta['window_rect'][3]-meta['window_rect'][1]])
            with self.assertRaises(ValueError):capture({'hwnd':hwnd,'fingerprint':'stale'},path.parent)
        finally:
            state['user'].PostMessageW.argtypes=[wt.HWND,wt.UINT,wt.WPARAM,wt.LPARAM]
            state['user'].PostMessageW(hwnd,0x10,0,0)
