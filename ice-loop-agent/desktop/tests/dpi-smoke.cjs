// M2-10 跨 DPI 几何冒烟：zoomFactor 100/125/150/200% 下的窗口/视口几何与截图。
// 需 desktop/ui/dist 已构建；--new-ui 由脚本自动附加。
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), runtime = path.join(root, '.test-tmp', 'dpi-smoke-' + Date.now());
fs.mkdirSync(runtime, { recursive: true });
const dist = path.join(root, 'desktop', 'ui', 'dist', 'index.html');
if (!fs.existsSync(dist)) { console.error('缺少 desktop/ui/dist，请先运行 npm run build:ui'); process.exit(1); }
const packaged = process.env.ICE_PACKAGED_EXE;
const env = { ...process.env, ICE_DESKTOP_RUNTIME: runtime };
if (packaged) { env.PATH = path.join(process.env.SystemRoot, 'System32'); for (const key of ['ICE_PYTHON', 'ICE_TEACHING_PYTHON', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_PATH']) delete env[key]; }
const args = packaged ? ['--dpi-smoke', '--new-ui'] : [path.join(root, 'desktop'), '--dpi-smoke', '--new-ui'];
const child = spawn(packaged || require('electron'), args, { cwd: root, windowsHide: true, env, stdio: 'pipe' });
let errors = ''; child.stderr.on('data', d => errors += d);
const timer = setTimeout(() => {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
  console.error('dpi smoke timeout', runtime); process.exitCode = 1;
}, 300000);
child.on('exit', code => {
  clearTimeout(timer);
  const result = path.join(runtime, 'dpi-geometry.json'), error = path.join(runtime, 'dpi-smoke-error.txt');
  if (code !== 0 || !fs.existsSync(result)) {
    console.error(fs.existsSync(error) ? fs.readFileSync(error, 'utf8') : errors, runtime);
    process.exitCode = 1;
  } else {
    const parsed = JSON.parse(fs.readFileSync(result, 'utf8'));
    const bad = parsed.rows.filter(row => row.viewport.overflowX);
    if (parsed.rows.length !== 4) { console.error('几何记录不足 4 档', runtime); process.exitCode = 1; }
    else if (bad.length) { console.error('横向溢出：' + JSON.stringify(bad), runtime); process.exitCode = 1; }
    else console.log(JSON.stringify({ runtime, display: parsed.display, rows: parsed.rows.map(r => ({ zoom: r.zoom, viewport: r.viewport, shot: r.screenshot })) }, null, 2));
  }
});
