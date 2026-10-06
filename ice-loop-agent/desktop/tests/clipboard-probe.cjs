const {app,clipboard,ClipboardItem}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),folder=path.join(root,'.test-tmp/clipboard-probe');fs.mkdirSync(folder,{recursive:true});app.setPath('userData',path.join(folder,'electron'));
app.whenReady().then(async()=>{
  const saved=[];let result={};
  try{
    for(const item of await clipboard.read()){if(!item.types.length)continue;const payload={};for(const type of item.types)payload[type]=await item.getType(type);saved.push(new ClipboardItem(payload));}
    await clipboard.write([new ClipboardItem({'text/html':'<p style="color:blue">剪贴板验收</p>','text/plain':'剪贴板验收'})]);
    await new Promise(resolve=>setTimeout(resolve,100));
    result.htmlHas=await clipboard.has('text/html');result.textMatched=(await clipboard.readText())==='剪贴板验收';
    const rows=await clipboard.read();result.types=rows.map(row=>row.types);
    const html=rows.find(row=>row.types.includes('text/html'));
    result.htmlLength=html?(await html.getType('text/html')).size:0;
    result.htmlValid=html?(await (await html.getType('text/html')).text()).includes('style='):false;
    await clipboard.writeText('ICE text probe');result.plainWriteMatched=(await clipboard.readText())==='ICE text probe';result.electronVersion=process.versions.electron;
  }catch(error){result.error=error.message;}
  finally{await clipboard.write(saved);fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(result));app.quit();}
});
