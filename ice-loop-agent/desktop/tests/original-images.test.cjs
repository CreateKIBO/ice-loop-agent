'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {OriginalImages}=require('../original-images.cjs');
const base=path.resolve(__dirname,'../../.test-tmp/original-image-grants');fs.mkdirSync(base,{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/A8AAAAASUVORK5CYII=','base64');
function fixture(t,options){const root=fs.mkdtempSync(path.join(base,'case-'));assert.equal(path.dirname(root),base);const file=path.join(root,'image.png');fs.writeFileSync(file,png);const leases=new OriginalImages(options);t.after(async()=>{await leases.clear();fs.rmSync(root,{recursive:true,force:true});});return {root,file,leases,source:{file_path:file,sha256:crypto.createHash('sha256').update(png).digest('hex'),mime:'image/png',size:png.length,width:1,height:1,account_id:'owned'}};}
const req=(url,extra={})=>({url,method:'GET',referrer:'ice://app/ui/index.html',signal:new AbortController().signal,...extra});
test('original grant streams exact immutable bytes without base64 and releases its descriptor',async t=>{
 const f=fixture(t),g=await f.leases.open(f.source),fd=f.leases.rows.get(g.token).fd;
 assert.match(g.url,/^ice:\/\/app\/__image\/[a-f0-9]{48}$/);assert(!('file_path' in g));
 const response=await f.leases.respond(req(g.url));assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 assert.equal((await f.leases.respond(req(g.url,{method:'HEAD'}))).headers.get('content-length'),String(png.length));
 await f.leases.release(g.token);assert.equal((await f.leases.respond(req(g.url))).status,404);await assert.rejects(fd.stat());assert.deepEqual(fs.readFileSync(f.file),png);
});
test('unknown and cross-origin requests cannot read a valid grant even with a forged referrer',async t=>{
 const f=fixture(t),g=await f.leases.open(f.source);
 for(const initiatorOrigin of ['https://app.tapnow.media','null','ice://other'])assert.equal((await f.leases.respond(req(g.url,{initiatorOrigin}))).status,403);
 assert.equal((await f.leases.respond(req(g.url,{referrer:''}))).status,403);
 assert.equal((await f.leases.respond(req(g.url+'?path=secret'))).status,404);
 assert.equal((await f.leases.respond(req(g.url,{method:'POST'}))).status,405);
 assert.equal((await f.leases.respond(req('ice://app/__image/'+'a'.repeat(48)))).status,404);
});
test('hash, size, mime and junction validation refuses changed or redirected sources',async t=>{
 const f=fixture(t);
 for(const patch of [{sha256:'0'.repeat(64)},{size:1},{mime:'image/jpeg'},{file_path:'relative.png'},{size:40*1048576}])await assert.rejects(f.leases.open({...f.source,...patch}));
 const link=path.join(f.root,'linked');fs.symlinkSync(f.root,link,process.platform==='win32'?'junction':'dir');
 await assert.rejects(f.leases.open({...f.source,file_path:path.join(link,'image.png')}),/链接/);fs.unlinkSync(link);
 assert.equal(f.leases.size,0);assert.equal(f.leases.opening,0);
});
test('account reset invalidates pending epochs and every opened URL without changing files',async t=>{
 const f=fixture(t),epoch=f.leases.epoch,g=await f.leases.open(f.source);await f.leases.clear();
 await assert.rejects(f.leases.open(f.source,epoch),/切换/);assert.equal((await f.leases.respond(req(g.url))).status,404);assert.deepEqual(fs.readFileSync(f.file),png);
});
test('capability count is bounded and a released slot can be reused',async t=>{
 const f=fixture(t,{limit:1});const g=await f.leases.open(f.source);await assert.rejects(f.leases.open(f.source),/过多/);await f.leases.release(g.token);await f.leases.open(f.source);assert.equal(f.leases.size,1);
});
test('changes after authorization revoke the grant instead of sending unreviewed bytes',async t=>{
 const f=fixture(t),g=await f.leases.open(f.source);fs.utimesSync(f.file,new Date(),new Date(Date.now()+2000));assert.equal((await f.leases.respond(req(g.url))).status,410);assert.equal(f.leases.size,0);
});
test('cancelling a reader keeps its grant bounded and release closes the stream handle',async t=>{
 const f=fixture(t),g=await f.leases.open(f.source),fd=f.leases.rows.get(g.token).fd;
 const response=await f.leases.respond(req(g.url));await response.body.cancel();await f.leases.release(g.token);await assert.rejects(fd.stat());assert.equal(f.leases.size,0);
});
test('expired grants are removed without deleting their source',async t=>{
 const f=fixture(t,{ttl:20});await f.leases.open(f.source);await new Promise(r=>setTimeout(r,80));assert.equal(f.leases.size,0);assert.deepEqual(fs.readFileSync(f.file),png);
});

test('readers per capability are bounded and reset rejects an in-flight open',async t=>{
 const f=fixture(t);const bytes=Buffer.concat([png,Buffer.alloc(3*1048576)]);fs.writeFileSync(f.file,bytes);
 const source={...f.source,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 const g=await f.leases.open(source),first=await f.leases.respond(req(g.url)),second=await f.leases.respond(req(g.url));
 assert.equal((await f.leases.respond(req(g.url))).status,429);
 await first.body.cancel();await second.body.cancel();await f.leases.release(g.token);
 const opening=f.leases.open(source);await f.leases.clear();await assert.rejects(opening,/取消/);assert.equal(f.leases.size,0);assert.equal(f.leases.opening,0);
});
