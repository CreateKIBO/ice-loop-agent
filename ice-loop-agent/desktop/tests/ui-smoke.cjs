// v2.0 新工作台原生冒烟：要求 desktop/ui/dist 已构建（npm run build:ui）。
// 用法：node tests/ui-smoke.cjs  （或设置 ICE_PACKAGED_EXE 验证打包版）
// 输出 runtime 下 ui-smoke-result.json；ok=true 表示新 UI 在 ice:// 协议下真实挂载。
const { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), runtime = path.join(root, '.test-tmp/ui-smoke-' + Date.now());
const dist = path.join(root, 'desktop', 'ui', 'dist', 'index.html');
if (!fs.existsSync(dist)) { console.error('缺少 desktop/ui/dist，请先运行 npm run build:ui'); process.exit(1); }
const packaged = process.env.ICE_PACKAGED_EXE;
const env = { ...process.env, ICE_DESKTOP_RUNTIME: runtime };
if (packaged) { env.PATH = path.join(process.env.SystemRoot, 'System32'); for (const key of ['ICE_PYTHON', 'ICE_TEACHING_PYTHON', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_PATH']) delete env[key]; }
const child = spawn(packaged || require('electron'), packaged ? ['--ui-smoke'] : [path.join(root, 'desktop'), '--ui-smoke'], { cwd: root, windowsHide: true, env, stdio: 'pipe' });
let errors = ''; child.stderr.on('data', d => errors += d);
const timer = setTimeout(() => {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
  console.error('ui smoke timeout', runtime); process.exitCode = 1;
}, 300000);
child.on('exit', code => {
  clearTimeout(timer);
  const result = path.join(runtime, 'ui-smoke-result.json'), error = path.join(runtime, 'ui-smoke-error.txt');
  if (code !== 0 || !fs.existsSync(result)) {
    console.error(fs.existsSync(error) ? fs.readFileSync(error, 'utf8') : errors, runtime);
    process.exitCode = 1;
  } else {
    const parsed = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (!parsed.ok) process.exitCode = 1;
    console.log(JSON.stringify({ runtime, ...parsed }, null, 2));
  }
});
