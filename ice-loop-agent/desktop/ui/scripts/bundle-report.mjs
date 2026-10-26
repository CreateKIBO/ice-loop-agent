import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export function inspectBundle(directory) {
  const root=path.resolve(directory), records=new Map(), missing=new Set(), external=new Set();
  const inside=file=>file===root||file.startsWith(root+path.sep);
  const local=(owner,spec)=>{
    if (/^(?:data:|#)/.test(spec)) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)||spec.startsWith('//')) { external.add(spec);return null; }
    const file=path.resolve(path.dirname(owner),decodeURIComponent(spec.split(/[?#]/)[0]));
    if(!inside(file))throw Error('Asset escapes bundle directory: '+spec);
    if(!fs.existsSync(file)){missing.add(path.relative(root,file).replaceAll(path.sep,'/'));return null;}
    return file;
  };
  const inspect=file=>{
    if(records.has(file))return;
    const text=fs.readFileSync(file,'utf8'), record={bytes:fs.statSync(file).size,static:[],dynamic:[]};records.set(file,record);
    const add=(spec,dynamic=false)=>{const target=local(file,spec);if(target){(dynamic?record.dynamic:record.static).push(target);if(/\.(?:js|css)$/.test(target))inspect(target);}};
    if(file.endsWith('.js')){
      const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      const walk=node=>{
        if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))add(node.moduleSpecifier.text);
        if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments.length&&ts.isStringLiteral(node.arguments[0]))add(node.arguments[0].text,true);
        // Vite preload maps contain root-relative asset literals, including CSS.
        if(ts.isStringLiteral(node)&&/^assets\/[^?#]+\.(?:js|css)$/.test(node.text)){
          const target=local(html,node.text);if(target){record.dynamic.push(target);inspect(target);}
        }
        ts.forEachChild(node,walk);
      };walk(tree);
    }else if(file.endsWith('.css')){
      for(const match of text.matchAll(/url\(\s*["']?([^\s)'";]+)["']?\s*\)/g))add(match[1]);
    }
  };
  const html=path.join(root,'index.html'), entryText=fs.readFileSync(html,'utf8');
  const scripts=[...entryText.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(m=>local(html,m[1])).filter(Boolean);
  const css=[...entryText.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css)["']/g)].map(m=>local(html,m[1])).filter(Boolean);
  const assets=[];const walkDir=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,item.name);if(item.isDirectory())walkDir(f);else if(/\.(?:js|css)$/.test(f))assets.push(f);}};walkDir(root);
  for(const f of assets)inspect(f);
  const closure=new Set();const visit=f=>{if(closure.has(f))return;closure.add(f);for(const target of records.get(f)?.static??[])visit(target);};for(const f of scripts)visit(f);
  return {entry:scripts.map(f=>path.relative(root,f).replaceAll('\\','/')),entry_js_bytes:scripts.reduce((n,f)=>n+fs.statSync(f).size,0),
    static_js_bytes:[...closure].filter(f=>f.endsWith('.js')).reduce((n,f)=>n+fs.statSync(f).size,0),
    static_js:[...closure].filter(f=>f.endsWith('.js')).map(f=>path.relative(root,f).replaceAll('\\','/')).sort(),
    entry_css_bytes:css.reduce((n,f)=>n+fs.statSync(f).size,0),files:assets.length,missing:[...missing].sort(),external:[...external].sort(),
    all_assets:assets.map(f=>({path:path.relative(root,f).replaceAll('\\','/'),bytes:fs.statSync(f).size})).sort((a,b)=>a.path.localeCompare(b.path))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const result=inspectBundle(process.argv[2]||fileURLToPath(new URL('../dist',import.meta.url)));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.missing.length||result.external.length)process.exitCode=1;
}
