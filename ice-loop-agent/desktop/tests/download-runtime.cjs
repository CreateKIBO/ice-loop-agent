// Windows download fallback when Node fetch cannot reach release assets.
// Downloads official byte ranges, then requires the npm package's official SHA256.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const file = 'electron-v44.5.1-win32-x64.zip';
const url = 'https://github.com/electron/electron/releases/download/v44.5.1/' + file;
const total = 157998329;
const chunks = 8;
const cache = path.join(root, '.electron-cache', 'gaps');
fs.mkdirSync(cache, {recursive:true});
const intervals = [];
const prefix = path.join(root, '.electron-cache', file);
if (fs.existsSync(prefix)) intervals.push({start:0, end:Math.min(total,fs.statSync(prefix).size), file:prefix});
for (let index=0; index<chunks; index++) {
  const candidate=path.join(root,'.electron-cache','ranges',index+'.part');
  const start=Math.floor(total*index/chunks);
  if (fs.existsSync(candidate)) intervals.push({start,end:Math.min(Math.floor(total*(index+1)/chunks),start+fs.statSync(candidate).size),file:candidate});
}
for (const name of fs.readdirSync(cache)) {
  const match=name.match(/^(\d+)-(\d+)\.part$/);
  if (match) { const start=Number(match[1]); const candidate=path.join(cache,name); intervals.push({start,end:Math.min(Number(match[2])+1,start+fs.statSync(candidate).size),file:candidate}); }
}
const pieces=[];
for (let pos=0; pos<total;) {
  const cover=intervals.filter(item=>item.start<=pos && item.end>pos).sort((a,b)=>b.end-a.end)[0];
  if (cover) { pieces.push({start:pos,end:cover.end,file:cover.file,offset:pos-cover.start}); pos=cover.end; }
  else { const next=Math.min(total,...intervals.filter(item=>item.start>pos).map(item=>item.start)); pieces.push({start:pos,end:next,file:path.join(cache,`${pos}-${next-1}.part`),offset:0,download:true}); pos=next; }
}
console.log('Missing bytes:',pieces.filter(p=>p.download).reduce((n,p)=>n+p.end-p.start,0));
function download(piece) {
  const {start, end, file:target}=piece;
  return new Promise((resolve, reject) => {
    const child = spawn('curl.exe', ['--fail','--location','--range',`${start}-${end-1}`,
      '--max-time','1200','--connect-timeout','30','--silent','--show-error','--output',target,url],
      {windowsHide:true,stdio:['ignore','ignore','pipe']});
    let error = ''; child.stderr.on('data', data => error += data);
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0 || !fs.existsSync(target) || fs.statSync(target).size !== end - start) return reject(Error(`range ${start} failed: ${error.slice(-120)}`));
      console.log('Range complete:',start,'-',end); resolve(target);
    });
  });
}
Promise.all(pieces.filter(p=>p.download).map(download)).then(() => {
  const target = path.join(root, '.electron-cache', 'parallel.zip');
  const handle = fs.openSync(target, 'w');
  const hash = crypto.createHash('sha256');
  try { for (const part of pieces) { const data = fs.readFileSync(part.file).subarray(part.offset,part.offset+part.end-part.start); hash.update(data); fs.writeSync(handle, data); } }
  finally { fs.closeSync(handle); }
  if (hash.digest('hex') !== require('../node_modules/electron/checksums.json')[file]) throw Error('Official checksum mismatch');
  console.log('Official SHA256 verified:', target);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
