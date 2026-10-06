/* Migration helper. Plaintext travels only through its parent's private pipe. */
const {app,safeStorage}=require('electron');const fs=require('node:fs');const path=require('node:path');
const value=flag=>process.argv[process.argv.indexOf(flag)+1];
const runtime=value('--helper-runtime'),source=value('--cipher-file');
if(!runtime||!source||!path.isAbsolute(runtime)||/^c:/i.test(runtime))process.exit(1);
app.setPath('userData',runtime);app.setPath('sessionData',path.join(runtime,'session'));app.setAppLogsPath(path.join(runtime,'logs'));
app.whenReady().then(()=>{
  const keys={};
  try{const stored=JSON.parse(fs.readFileSync(source,'utf8'));for(const [provider,encrypted] of Object.entries(stored)){
    try{keys[provider]=safeStorage.decryptString(Buffer.from(encrypted,'base64'));}catch{}
  }process.stdout.write(JSON.stringify({keys})+'\n');}catch{process.stdout.write('{"keys":{}}\n');}
  app.quit();
});
