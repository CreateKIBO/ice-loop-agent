const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {transformSync}=require('../node_modules/esbuild');
const source=fs.readFileSync(path.join(__dirname,'../ui/src/features/chat/tokenReceipt.ts'),'utf8');
const mod={exports:{}};vm.runInNewContext(transformSync(source,{loader:'ts',format:'cjs'}).code,{module:mod,exports:mod.exports});
const {tokenReceipt}=mod.exports;
test('token receipt only confirms a complete numeric reservation',()=>{
 const row=tokenReceipt({state:'checked',input_tokens:80,output_reserved:20,context_window:100,window_source:'user'});
 assert.match(row.summary,/80/);assert.match(row.detail,/手动窗口 100/);assert.match(row.detail,/实际计费/);
 const invalid=tokenReceipt({state:'checked',input_tokens:95,output_reserved:20,context_window:100});assert.doesNotMatch(invalid.detail,/已按供应商计数核验/);
});
test('unknown or disabled counting never becomes a passed window check',()=>{
 for(const state of ['unsupported','disabled'])assert.doesNotMatch(tokenReceipt({state}).detail,/已按供应商计数核验/);
 assert.match(tokenReceipt({state:'incomplete',input_tokens:80}).summary,/未完成窗口核验/);
 assert.match(tokenReceipt({state:'blocked',input_tokens:95,output_reserved:20,context_window:100}).detail,/未发送生成请求/);
});
test('persisted invalid metadata cannot inject text or misleading token counts',()=>{
 for(const value of [null,[],{state:'new-untrusted-state'},{state:'checked',input_tokens:true},{state:'checked',input_tokens:Infinity},{state:'checked',input_tokens:'<script>'}]){
  const row=tokenReceipt(value);assert.ok(row===null||row.summary.includes('不完整'));if(row)assert.doesNotMatch(row.summary+row.detail,/<script>/);
 }
 const row=tokenReceipt({state:'checked',input_tokens:10,output_reserved:20,context_window:100,window_source:'<script>secret</script>'});assert.doesNotMatch(row.detail,/script|secret/);
});
