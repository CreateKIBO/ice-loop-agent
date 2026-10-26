'use strict';
const fs=require('node:fs'),path=require('node:path');
const {build,Platform,Arch}=require('../desktop/node_modules/electron-builder');
const {createScript,installTemplateHook}=require('./nsis-upgrade-template.cjs');
const configFile=path.resolve(process.argv[2]),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const script=createScript(path.join(path.dirname(configFile),'nsis-template'));
installTemplateHook(()=>script);
const targets=process.argv.includes('--installer')?['nsis','zip']:['zip'];
let complete=false;
process.on('beforeExit',()=>{if(!complete)process.exitCode=1;});
// builder dependencies may call process.exit(0) during cleanup; retain real failure.
process.on('exit',()=>{if(!complete)process.exitCode=1;});
build({projectDir:path.resolve(__dirname,'../desktop'),config:configFile,publish:'never',targets:Platform.WINDOWS.createTarget(targets,Arch.x64)}).then(()=>{complete=true;}).catch(error=>{console.error(error.stack);process.exitCode=1;});
