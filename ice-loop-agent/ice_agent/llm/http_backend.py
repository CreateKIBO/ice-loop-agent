"""Public HTTPX/HTTPCore extension interfaces with cancellation-safe TLS ownership.

HTTPCore 1.0.9's AnyIOStream.start_tls catches Exception, so asyncio cancellation
(BaseException) can lose the raw TCP stream before it reaches the pool. Keep an
owner around that handshake and explicitly close it on every exceptional exit.
"""
import asyncio
import urllib.request
from urllib.parse import urlparse

import httpcore
import httpx


async def _close(stream):
    cleanup=asyncio.create_task(stream.aclose())
    while not cleanup.done():
        try:await asyncio.shield(cleanup)
        except asyncio.CancelledError:continue
    cleanup.result()


class _OwnedStream(httpcore.AsyncNetworkStream):
    def __init__(self,stream):self.stream=stream
    async def read(self,max_bytes,timeout=None):return await self.stream.read(max_bytes,timeout)
    async def write(self,buffer,timeout=None):return await self.stream.write(buffer,timeout)
    async def aclose(self):await _close(self.stream)
    def get_extra_info(self,info):return self.stream.get_extra_info(info)
    async def start_tls(self,ssl_context,server_hostname=None,timeout=None):
        try:
            upgraded=await self.stream.start_tls(ssl_context,server_hostname,timeout)
        except BaseException:
            await _close(self.stream)
            raise
        return _OwnedStream(upgraded)


class _OwnedBackend(httpcore.AsyncNetworkBackend):
    def __init__(self):self.backend=httpcore.AnyIOBackend()
    async def connect_tcp(self,*args,**kwargs):return _OwnedStream(await self.backend.connect_tcp(*args,**kwargs))
    async def connect_unix_socket(self,*args,**kwargs):return _OwnedStream(await self.backend.connect_unix_socket(*args,**kwargs))
    async def sleep(self,seconds):await self.backend.sleep(seconds)


def configured_proxy(endpoint,*,allow_loopback=False):
    """Preserve urllib's configured HTTP(S) proxies and NO_PROXY, no implicit proxy."""
    target=urlparse(endpoint)
    if allow_loopback or urllib.request.proxy_bypass(target.netloc):return None
    proxies=urllib.request.getproxies()
    return proxies.get(target.scheme) or proxies.get('all')


class _ResponseStream(httpx.AsyncByteStream):
    def __init__(self,stream):self.stream=stream
    async def __aiter__(self):
        async for chunk in self.stream:yield chunk
    async def aclose(self):await _close(self.stream)


class OwnedHTTPTransport(httpx.AsyncBaseTransport):
    def __init__(self,trust,proxy=None):
        options={'ssl_context':trust,'network_backend':_OwnedBackend(),'max_connections':1,'max_keepalive_connections':0}
        if proxy:
            parsed=httpx.Proxy(proxy)
            if parsed.url.scheme not in ('http','https'):raise ValueError('Unsupported configured proxy scheme')
            self.pool=httpcore.AsyncHTTPProxy(proxy_url=httpcore.URL(scheme=parsed.url.raw_scheme,
                host=parsed.url.raw_host,port=parsed.url.port,target=parsed.url.raw_path),
                proxy_auth=parsed.raw_auth,proxy_headers=parsed.headers.raw,proxy_ssl_context=trust,**options)
        else:self.pool=httpcore.AsyncConnectionPool(**options)

    async def handle_async_request(self,request):
        response=await self.pool.handle_async_request(httpcore.Request(method=request.method,
            url=httpcore.URL(scheme=request.url.raw_scheme,host=request.url.raw_host,port=request.url.port,target=request.url.raw_path),
            headers=request.headers.raw,content=request.stream,extensions=request.extensions))
        return httpx.Response(response.status,headers=response.headers,stream=_ResponseStream(response.stream),extensions=response.extensions)

    async def aclose(self):await _close(self.pool)
