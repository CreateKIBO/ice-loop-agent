/* A UI-only rebuild can reuse the already verified engine/runtime resources. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),folder=path.join(root,'.test-tmp');
const config=JSON.parse(fs.readFileSync(path.join(root,'desktop/electron-builder.json'),'utf8'));
config.extraResources=[];config.directories.output=path.join(folder,'ui-layer');
fs.writeFileSync(path.join(folder,'builder-ui.json'),JSON.stringify(config,null,2));
console.log('UI packaging config prepared');
