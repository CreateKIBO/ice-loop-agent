"""Selected-window Win32 capture; never falls back to photographing the desktop."""
import ctypes as ct
from ctypes import wintypes as wt
import os
from pathlib import Path
from PIL import Image,ImageStat
from .domain.types import new_id,now_iso,sha256_json
from .paths import ensure_dir

def api():
    if os.name!='nt':raise ValueError('原生程序截图仅支持Windows')
    user=ct.WinDLL('user32',use_last_error=True);kernel=ct.WinDLL('kernel32',use_last_error=True);gdi=ct.WinDLL('gdi32',use_last_error=True)
    user.GetWindowDC.argtypes=[wt.HWND];user.GetWindowDC.restype=wt.HDC
    user.ReleaseDC.argtypes=[wt.HWND,wt.HDC]
    user.OpenInputDesktop.restype=wt.HANDLE;user.CloseDesktop.argtypes=[wt.HANDLE]
    kernel.OpenProcess.restype=wt.HANDLE;kernel.CloseHandle.argtypes=[wt.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes=[wt.HANDLE,wt.DWORD,wt.LPWSTR,ct.POINTER(wt.DWORD)]
    gdi.CreateCompatibleDC.argtypes=[wt.HDC];gdi.CreateCompatibleDC.restype=wt.HDC
    gdi.CreateCompatibleBitmap.argtypes=[wt.HDC,ct.c_int,ct.c_int];gdi.CreateCompatibleBitmap.restype=wt.HBITMAP
    gdi.SelectObject.argtypes=[wt.HDC,wt.HANDLE];gdi.SelectObject.restype=wt.HANDLE
    gdi.DeleteDC.argtypes=[wt.HDC];gdi.DeleteObject.argtypes=[wt.HANDLE]
    user.PrintWindow.argtypes=[wt.HWND,wt.HDC,wt.UINT]
    user.GetWindowRect.argtypes=[wt.HWND,ct.POINTER(wt.RECT)]
    user.GetWindowThreadProcessId.argtypes=[wt.HWND,ct.POINTER(wt.DWORD)]
    user.GetWindowTextW.argtypes=[wt.HWND,wt.LPWSTR,ct.c_int]
    user.IsWindowVisible.argtypes=[wt.HWND];user.IsIconic.argtypes=[wt.HWND]
    if hasattr(user,'GetDpiForWindow'):user.GetDpiForWindow.argtypes=[wt.HWND]
    return user,kernel,gdi

def fingerprint(hwnd,user,kernel):
    pid=wt.DWORD();user.GetWindowThreadProcessId(hwnd,ct.byref(pid));title=ct.create_unicode_buffer(1024);user.GetWindowTextW(hwnd,title,1024)
    process=kernel.OpenProcess(0x1000,False,pid.value);exe=''
    if process:
        try:
            buf=ct.create_unicode_buffer(32768);length=wt.DWORD(32768)
            if kernel.QueryFullProcessImageNameW(process,0,buf,ct.byref(length)):exe=buf.value
        finally:kernel.CloseHandle(process)
    return {'hwnd':int(hwnd),'pid':pid.value,'title':title.value,'executable':exe}

def windows():
    user,kernel,_=api();rows=[];callback=ct.WINFUNCTYPE(wt.BOOL,wt.HWND,wt.LPARAM)
    @callback
    def visit(hwnd,lparam):
        if user.IsWindowVisible(hwnd) and not user.IsIconic(hwnd):
            row=fingerprint(hwnd,user,kernel)
            if row['title'] and row['executable']:
                row['fingerprint']=sha256_json(row);rows.append(row)
        return True
    user.EnumWindows(visit,0);return rows

class BITMAPINFOHEADER(ct.Structure):
    _fields_=[('biSize',wt.DWORD),('biWidth',wt.LONG),('biHeight',wt.LONG),('biPlanes',wt.WORD),('biBitCount',wt.WORD),('biCompression',wt.DWORD),('biSizeImage',wt.DWORD),('biXPelsPerMeter',wt.LONG),('biYPelsPerMeter',wt.LONG),('biClrUsed',wt.DWORD),('biClrImportant',wt.DWORD)]

def capture(params,runtime):
    user,kernel,gdi=api();hwnd=params.get('hwnd')
    if type(hwnd) is not int:raise ValueError('请选择已列出的窗口')
    desktop=user.OpenInputDesktop(0,False,1)
    if not desktop:raise ValueError('当前会话已锁定或不可捕获，请解锁后重试')
    user.CloseDesktop(desktop)
    row=next((r for r in windows() if r['hwnd']==hwnd),None)
    if not row or row['fingerprint']!=params.get('fingerprint'):raise ValueError('窗口已关闭或标题/进程已变化，请重新选择')
    old=None
    if hasattr(user,'SetThreadDpiAwarenessContext'):
        user.SetThreadDpiAwarenessContext.argtypes=[ct.c_void_p];user.SetThreadDpiAwarenessContext.restype=ct.c_void_p
        old=user.SetThreadDpiAwarenessContext(ct.c_void_p(-4))
    dc=mem=bitmap=previous=None
    try:
        rect=wt.RECT()
        if not user.GetWindowRect(hwnd,ct.byref(rect)):raise ValueError('窗口尺寸读取失败')
        width,height=rect.right-rect.left,rect.bottom-rect.top
        if not 32<=width<=10000 or not 32<=height<=10000 or width*height>40000000:raise ValueError('窗口尺寸不适合截图')
        dc=user.GetWindowDC(hwnd);mem=gdi.CreateCompatibleDC(dc);bitmap=gdi.CreateCompatibleBitmap(dc,width,height);previous=gdi.SelectObject(mem,bitmap)
        if not user.PrintWindow(hwnd,mem,2):raise ValueError('程序未响应窗口捕获，请手动截图导入')
        gdi.SelectObject(mem,previous);previous=None
        info=BITMAPINFOHEADER(ct.sizeof(BITMAPINFOHEADER),width,-height,1,32,0,0,0,0,0,0);buffer=ct.create_string_buffer(width*height*4)
        gdi.GetDIBits.argtypes=[wt.HDC,wt.HBITMAP,wt.UINT,wt.UINT,ct.c_void_p,ct.c_void_p,wt.UINT]
        if not gdi.GetDIBits(mem,bitmap,0,height,buffer,ct.byref(info),0):raise ValueError('窗口像素读取失败')
        image=Image.frombytes('RGB',(width,height),buffer.raw,'raw','BGRX')
        if max(ImageStat.Stat(image).stddev)<2:raise ValueError('截图为空白或黑屏，请手动截图导入')
        fresh=fingerprint(hwnd,user,kernel)
        if sha256_json(fresh)!=row['fingerprint']:raise ValueError('捕获期间窗口内容标识已变化，请重试')
        file=ensure_dir(runtime/'captures'/'native')/(new_id('capture')+'.png');image.save(file)
        dpi=user.GetDpiForWindow(hwnd) if hasattr(user,'GetDpiForWindow') else 96
        return file,{'capture_mode':'native_window','target':row,'dpi':dpi,'window_rect':[rect.left,rect.top,rect.right,rect.bottom],'physical_size':[width,height],'captured_at':now_iso(),'ordering_semantics':'window_pixels'}
    finally:
        if previous:gdi.SelectObject(mem,previous)
        if bitmap:gdi.DeleteObject(bitmap)
        if mem:gdi.DeleteDC(mem)
        if dc:user.ReleaseDC(hwnd,dc)
        if old:user.SetThreadDpiAwarenessContext(old)
