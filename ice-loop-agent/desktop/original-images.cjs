'use strict';
// Authenticated desktop-only grants. No raw renderer-supplied path and no base64 IPC body.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const PREFIX='/__image/';
class OriginalImages {
 constructor({limit=8,ttl=15*60*1000}={}){this.limit=limit;this.ttl=ttl;this.epoch=0;this.rows=new Map();this.opening=0;}
 get size(){return this.rows.size;}
 async open(source,epoch=this.epoch){
  if(epoch!==this.epoch)throw Error('公众号或页面已切换，请重新打开图片');
  if(this.rows.size+this.opening>=this.limit)throw Error('同时打开的原图过多，请关闭其他原图后重试');
  if(!source||typeof source.file_path!=='string'||!path.isAbsolute(source.file_path)||
    !/^[a-f0-9]{64}$/.test(source.sha256)||!['image/png','image/jpeg','image/webp'].includes(source.mime)||
    !Number.isInteger(source.size)||source.size<=0||source.size>32*1024*1024)throw Error('原图授权记录无效');
  this.opening++;let fd;
  try{
   const canonical=await fs.promises.realpath(source.file_path),requested=path.resolve(source.file_path);
   if(canonical.toLowerCase()!==requested.toLowerCase()||(await fs.promises.lstat(requested)).isSymbolicLink())throw Error('原图路径不能经过链接');
   fd=await fs.promises.open(canonical,'r');const stat=await fd.stat();
   if(!stat.isFile()||stat.size!==source.size)throw Error('原图文件已变化');
   const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(128*1024);let position=0;
   while(position<stat.size){if(epoch!==this.epoch)throw Error('原图读取已取消');const {bytesRead}=await fd.read(buffer,0,Math.min(buffer.length,stat.size-position),position);if(!bytesRead)throw Error('原图读取中断');if(position===0){const png=bytesRead>=8&&buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpg=bytesRead>=3&&buffer.subarray(0,3).equals(Buffer.from('ffd8ff','hex')),webp=bytesRead>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';if(!((source.mime==='image/png'&&png)||(source.mime==='image/jpeg'&&jpg)||(source.mime==='image/webp'&&webp)))throw Error('原图格式与内容不符');}hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
   const after=await fd.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||hash.digest('hex')!==source.sha256)throw Error('原图内容已变化');
   if(epoch!==this.epoch)throw Error('原图读取已取消');
   const token=crypto.randomBytes(24).toString('hex'),row={fd,mime:source.mime,size:stat.size,stat,streams:new Set(),closed:false};
   row.timer=setTimeout(()=>void this.release(token),this.ttl);row.timer.unref?.();this.rows.set(token,row);fd=null;
   return {token,url:'ice://app'+PREFIX+token,width:source.width,height:source.height,transport:'stream'};
  }finally{this.opening--;if(fd)await fd.close();}
 }
 async release(token){
  const row=this.rows.get(token);if(!row)return false;this.rows.delete(token);row.closed=true;clearTimeout(row.timer);
  for(const stream of row.streams)stream.destroy();row.streams.clear();await row.fd.close();return true;
 }
 async clear(){this.epoch++;await Promise.allSettled([...this.rows.keys()].map(token=>this.release(token)));}
 async respond(request){
  const url=new URL(request.url),token=url.pathname.slice(PREFIX.length);
  if(url.hostname!=='app'||!url.pathname.startsWith(PREFIX)||url.search||!/^[a-f0-9]{48}$/.test(token))return new Response('not found',{status:404});
  const origin=request.initiatorOrigin;
  let trusted=origin==='ice://app';
  if(origin===undefined){try{const ref=new URL(request.referrer);trusted=ref.protocol==='ice:'&&ref.hostname==='app'&&['/ui/index.html','/index.html'].includes(ref.pathname);}catch{}}
  if(!trusted)return new Response('forbidden',{status:403});
  if(!['GET','HEAD'].includes(request.method))return new Response('method not allowed',{status:405});
  const row=this.rows.get(token);if(!row||row.closed)return new Response('not found',{status:404});
  const stat=await row.fd.stat().catch(()=>null);
  if(row.closed||this.rows.get(token)!==row)return new Response('not found',{status:404});
  if(!stat||stat.size!==row.stat.size||stat.mtimeMs!==row.stat.mtimeMs){await this.release(token);return new Response('image changed',{status:410});}
  if(request.signal?.aborted)return new Response(null,{status:499});
  const headers={'content-type':row.mime,'content-length':String(row.size),'cache-control':'no-store','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin','content-security-policy':"default-src 'none'; frame-ancestors 'none'"};
  if(request.method==='HEAD')return new Response(null,{headers});
  if(row.streams.size>=2)return new Response('too many readers',{status:429});
  const stream=row.fd.createReadStream({start:0,end:row.size-1,autoClose:false,highWaterMark:64*1024});row.streams.add(stream);
  const abort=()=>stream.destroy();request.signal?.addEventListener('abort',abort,{once:true});
  stream.once('close',()=>{row.streams.delete(stream);request.signal?.removeEventListener('abort',abort);});
  return new Response(Readable.toWeb(stream),{headers});
 }
}
module.exports={OriginalImages,PREFIX};
