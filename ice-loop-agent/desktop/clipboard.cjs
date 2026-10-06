/* A successful API return alone does not prove the OS clipboard was written. */
const message='当前系统剪贴板不可用或拒绝访问。可从下方内容手动选择复制，或稍后重试。';
const normalize=text=>String(text).replace(/\r\n/g,'\n');
async function attempt(write,check){
  for(let i=0;i<3;i++){
    try{await write();if(await check())return true;}catch{}
    if(i<2)await new Promise(resolve=>setTimeout(resolve,75));
  }
  return false;
}
async function copyTextVerified(adapter,text){
  const ok=await attempt(()=>adapter.writeText(text),async()=>normalize(await adapter.readText())===normalize(text));
  return ok?{ok:true}:{ok:false,clipboard_unavailable:true,message,text};
}
async function copyRichVerified(adapter,makeItem,{html,text,image_count}){
  const ok=await attempt(()=>adapter.write([makeItem({'text/html':html,'text/plain':text})]),async()=>{
    if(normalize(await adapter.readText())!==normalize(text))return false;
    const item=(await adapter.read()).find(row=>row.types.includes('text/html'));
    return Boolean(item)&&(await (await item.getType('text/html')).text()).includes(html);
  });
  return ok?{ok:true,image_count,html_verified:true}:{ok:false,image_count,clipboard_unavailable:true,message,html,text};
}
module.exports={copyTextVerified,copyRichVerified};
