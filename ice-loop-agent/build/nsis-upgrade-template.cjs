// Pinned NSIS adaptation: stage after elevation; never invoke an old uninstaller.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const templates=path.resolve(__dirname,'../desktop/node_modules/app-builder-lib/templates/nsis');
function once(source,needle,replacement){
 assert.equal(source.split(needle).length,2,'Pinned NSIS template changed: '+needle);
 return source.replace(needle,replacement);
}
function createScript(output,{legacyFixture=false,installerCache}={}){
 assert.equal(require('../desktop/node_modules/app-builder-lib/package.json').version,'26.0.12','Re-audit NSIS template before upgrading electron-builder');
 fs.mkdirSync(output,{recursive:true});
 let main=fs.readFileSync(path.join(templates,'installer.nsi'),'utf8');
 let section=fs.readFileSync(path.join(templates,'installSection.nsh'),'utf8');
 let functions=fs.readFileSync(path.join(templates,'include/installer.nsh'),'utf8');
 let utilities=fs.readFileSync(path.join(templates,'include/installUtil.nsh'),'utf8');
 let extraction=fs.readFileSync(path.join(templates,'include/extractAppPackage.nsh'),'utf8');
 if(!legacyFixture){
  const first='Function GetInQuotes',keep='Var /GLOBAL isTryToKeepShortcuts',end='# https://nsis-dev.github.io/NSIS-Forums/html/t-172971.html';
  for(const anchor of [first,keep,end])assert.equal(utilities.split(anchor).length,2,'Pinned utilities changed');
  // Omit old-uninstaller functions entirely, including their private helper functions.
  utilities=utilities.slice(0,utilities.indexOf(first))+utilities.slice(utilities.indexOf(keep),utilities.indexOf(end));
  section=once(section,'Var /GLOBAL keepShortcuts','!insertmacro IceStageUpgrade\n\nVar /GLOBAL keepShortcuts');
  for(const hive of ['SHELL_CONTEXT','HKEY_CURRENT_USER']){
   section=once(section,'!insertmacro uninstallOldVersion '+hive,'# Old uninstallers are never executed.');
   section=once(section,'!insertmacro handleUninstallResult '+hive,'# Upgrade transaction owns rollback.');
  }
  const failedZip='    StrCmp $R0 "success" +3\n      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)$\\n$R0"\n      Quit';
  const safeZip='    ${If} $R0 != "success"\n      Call IceRollbackUpgrade\n      SetErrorLevel 22\n      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK\n      Quit\n    ${EndIf}';
  extraction=once(extraction,failedZip,safeZip);
  extraction=once(extraction,'  AbortExtract7za:\n    Quit','  AbortExtract7za:\n    Call IceRollbackUpgrade\n    SetErrorLevel 22\n    Quit');
 }
 if(installerCache){
  assert(path.isAbsolute(installerCache),'Test cache must be an owned absolute path');
  functions=once(functions,'!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"','!insertmacro copyFile "$EXEPATH" "'+installerCache+'"');
 }
 const utilityFile=path.join(output,'install-util.nsh');
 const extracted=path.join(output,'extract-app.nsh'),helpers=path.join(output,'install-helpers.nsh'),body=path.join(output,'install-body.nsh'),script=path.join(output,'installer.nsi');
 functions=once(functions,'!include "extractAppPackage.nsh"','!include "'+extracted+'"');
 section=once(section,'!include installer.nsh','!include "'+helpers+'"');
 main=once(main,'!include "installUtil.nsh"','!include "'+utilityFile+'"');
 main=once(main,'!include "installSection.nsh"','!include "'+body+'"');
 for(const [file,data] of [[utilityFile,utilities],[extracted,extraction],[helpers,functions],[body,section],[script,main]])fs.writeFileSync(file,data);
 return script;
}
function installTemplateHook(selectScript){
 // Keep builder's default uninstaller generation/signing path. Do not use nsis.script.
 const {NsisTarget}=require('../desktop/node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
 const original=NsisTarget.prototype.executeMakensis;
 NsisTarget.prototype.executeMakensis=function(defines,commands,script){
  const chosen=selectScript(this);
  assert(chosen&&path.isAbsolute(chosen),'Missing reviewed NSIS template');
  const body=path.join(path.dirname(chosen),'install-body.nsh');
  script=once(script,'!include "installUtil.nsh"','!include "'+path.join(path.dirname(chosen),'install-util.nsh')+'"');
  return original.call(this,defines,commands,once(script,'!include "installSection.nsh"','!include "'+body+'"'));
 };
 return ()=>{NsisTarget.prototype.executeMakensis=original;};
}
module.exports={createScript,installTemplateHook};
