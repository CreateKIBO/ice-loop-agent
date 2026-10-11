/* 校验发行包 app.asar 含新工作台产物（M9-06 同源审计的一部分）。
   用 @electron/asar CLI 文本输出（listPackage 返回形状随版本不稳）。 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const asarCli = path.resolve(__dirname, '..', 'desktop', 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const asarPath = path.resolve(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
const node = process.env.NODE_EXE || 'E:/Node/node.exe';
const listing = execFileSync(node, [asarCli, 'list', asarPath], { encoding: 'utf8' });
const entries = listing.split(/\r?\n/).filter(Boolean)
  .map(f => f.replace(/\\/g, '/').replace(/^\//, ''));
const uiEntries = entries.filter(f => f.startsWith('ui/dist/'));
console.log('asar entries:', entries.length, '| ui/dist entries:', uiEntries.length);
if (!uiEntries.includes('ui/dist/index.html')) {
  throw new Error('asar 缺少 ui/dist/index.html');
}
if (!uiEntries.some(f => /^ui\/dist\/assets\/index-.*\.js$/.test(f))) {
  throw new Error('asar 缺少 ui/dist 主 bundle');
}
console.log('ASAR_UI_OK');
