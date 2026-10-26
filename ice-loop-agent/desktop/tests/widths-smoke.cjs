'use strict';
// 批次B-07 宽度回归（2026-10-20 后续任务）：真实 Electron 窗口在 500/800/1024/1280
// CSS 视口下，注入长中文标题与超长无空格串后页面不得横向溢出。
// 用法：先 npm --prefix desktop run build:ui，再 node tests/widths-smoke.cjs
// 与 dpi-smoke（zoomFactor 网页缩放近似）分开报告；物理系统 DPI 不在本脚本范围。
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), runtime = path.join(root, '.test-tmp', 'widths-smoke-' + Date.now());
const dist = path.join(root, 'desktop', 'ui', 'dist', 'index.html');
if (!fs.existsSync(dist)) { console.error('缺少 desktop/ui/dist，请先运行 npm --prefix desktop run build:ui'); process.exit(1); }
const packaged = process.env.ICE_PACKAGED_EXE;
const env = { ...process.env, ICE_DESKTOP_RUNTIME: runtime };
if (packaged) { env.PATH = path.join(process.env.SystemRoot, 'System32'); for (const key of ['ICE_PYTHON', 'ICE_TEACHING_PYTHON', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_PATH']) delete env[key]; }
const child = spawn(packaged || require('electron'), packaged ? ['--widths-smoke', '--new-ui'] : [path.join(root, 'desktop'), '--widths-smoke', '--new-ui'], { cwd: root, windowsHide: true, env, stdio: 'pipe' });
let errors = ''; child.stderr.on('data', d => errors += d);
const timer = setTimeout(() => {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
  console.error('widths smoke timeout', runtime); process.exitCode = 1;
}, 240000);
child.on('exit', code => {
  clearTimeout(timer);
  const report = path.join(runtime, 'widths-report.json');
  if (!fs.existsSync(report)) {
    console.error(errors || ('missing widths-report.json, exit=' + code), runtime); process.exitCode = 1; return;
  }
  const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  console.log(JSON.stringify({ runtime, ...parsed }, null, 2));
  // 任一宽度横向溢出 → 非零退出；注入目标缺失也视为失败（防止空页面假通过）。
  if (!parsed.ok || !Array.isArray(parsed.injected) || !parsed.injected.length) process.exitCode = 1;
});
