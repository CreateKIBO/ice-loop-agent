const fs = require('node:fs'), path = require('node:path');
const root = __dirname, vendor = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
require('esbuild').buildSync({ entryPoints:[path.join(root,'renderer/components-entry.js')],bundle:true,minify:true,format:'iife',outfile:path.join(vendor,'components.js'),legalComments:'eof' });
require('esbuild').buildSync({ entryPoints:[path.join(root,'renderer/motion-entry.js')],bundle:true,minify:true,format:'iife',outfile:path.join(vendor,'motion.js'),legalComments:'eof' });
for (const [source, destination] of [
  ['lucide/dist/umd/lucide.js','lucide.js'],
  ['@shoelace-style/shoelace/dist/themes/light.css','shoelace-light.css'],
  ['@shoelace-style/shoelace/LICENSE.md','Shoelace-LICENSE.md'],
  ['@shoelace-style/localize/LICENSE.md','Localize-LICENSE.md'],
  ['lucide/LICENSE','Lucide-LICENSE.txt'],
  ['motion/LICENSE.md','Motion-LICENSE.md'],
  ['framer-motion/LICENSE.md','Framer-Motion-LICENSE.md'],
  ['motion-dom/LICENSE.md','Motion-DOM-LICENSE.md'],
  ['motion-utils/LICENSE.md','Motion-Utils-LICENSE.md'],
  ['tslib/LICENSE.txt','Tslib-LICENSE.txt'],
  ['@shoelace-style/shoelace/node_modules/lit/LICENSE','Lit-LICENSE.txt']
]) {
  let file=path.join(root,'node_modules',source);
  if(!fs.existsSync(file)&&source.includes('node_modules/lit'))file=path.join(root,'node_modules/lit/LICENSE');
  if(fs.existsSync(file)){
    if(destination==='lucide.js')fs.writeFileSync(path.join(vendor,destination),require('esbuild').transformSync(fs.readFileSync(file,'utf8'),{minify:true,legalComments:'eof'}).code);
    else fs.copyFileSync(file,path.join(vendor,destination));
  }else throw Error('Component license or resource missing: '+source);
}
console.log('Local components bundled.');
