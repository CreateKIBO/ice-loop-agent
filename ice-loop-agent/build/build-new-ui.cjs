/* v2.0 新工作台构建包装：vite build + 校验 ui/dist/index.html 产物存在。
   PS 5.1 下 vite 的 stderr 输出会让 $LASTEXITCODE 语义不稳，统一走 node 入口。 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ui = path.resolve(__dirname, '..', 'desktop', 'ui');
const node = process.env.NODE_EXE || 'E:/Node/node.exe';
execFileSync(node, ['node_modules/vite/bin/vite.js', 'build'], {
  cwd: ui, stdio: 'inherit',
});
if (!fs.existsSync(path.join(ui, 'dist', 'index.html'))) {
  throw new Error('ui/dist/index.html 未生成');
}
console.log('New UI build OK');
