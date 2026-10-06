const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {installTools}=require('../tools.cjs');
const root=path.resolve(__dirname,'../..');
const runtime=path.join(root,'.test-tmp','capture-probe');fs.mkdirSync(runtime,{recursive:true});
app.setPath('userData',path.join(runtime,'electron'));
app.whenReady().then(async()=>{
  try{
    const file=path.join(runtime,'preview.html');
    fs.writeFileSync(file,'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><main style="background:#2448DB;width:900px;height:8000px">本地长页截图验收<script>throw Error("Must not execute page scripts")</script></main>');
    const tools=installTools({window:()=>null,assertSender:()=>{},request:async(method,params)=>params,runtime});
    const result=await tools.capture(file,'main',true);
    fs.writeFileSync(path.join(runtime,'result.json'),JSON.stringify(result));
  }catch(error){fs.writeFileSync(path.join(runtime,'error.txt'),error.stack);process.exitCode=1;}
  app.quit();
});
