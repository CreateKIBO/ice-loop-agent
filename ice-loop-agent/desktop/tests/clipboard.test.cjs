const test=require('node:test'),assert=require('node:assert/strict');
const {copyTextVerified,copyRichVerified}=require('../clipboard.cjs');
test('silent OS clipboard denial cannot report text copied',async()=>{
  const result=await copyTextVerified({writeText:async()=>{},readText:async()=>''},'prompt');
  assert.equal(result.ok,false);assert.equal(result.clipboard_unavailable,true);assert.equal(result.text,'prompt');
});
test('clipboard exceptions preserve complete rich manual fallback',async()=>{
  const data={html:'<p style="color:blue">正文</p>',text:'正文',image_count:1};
  const result=await copyRichVerified({write:async()=>{throw Error('access denied');}},p=>p,data);
  assert.equal(result.ok,false);assert.equal(result.html,data.html);assert.equal(result.image_count,1);
});
test('text success requires matching readback with Windows newline normalization',async()=>{
  const result=await copyTextVerified({writeText:async()=>{},readText:async()=>'first\r\nsecond'},'first\nsecond');assert.equal(result.ok,true);
});
test('rich success requires both HTML and plain text readback',async()=>{
  const data={html:'<p style="color:blue">正文</p>',text:'正文',image_count:1};
  const adapter={write:async()=>{},readText:async()=>'正文',read:async()=>[{types:['text/html'],getType:async()=>new Blob([data.html])}]};
  assert.equal((await copyRichVerified(adapter,p=>p,data)).html_verified,true);
});
