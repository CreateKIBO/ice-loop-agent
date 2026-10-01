const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, safeStorage, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');

const project = path.resolve(__dirname, '..');
const runtime = process.env.ICE_DESKTOP_RUNTIME || path.join(project, '.desktop-runtime');
fs.mkdirSync(runtime, { recursive: true });
for (const folder of ['electron', 'electron/sessions', 'electron/crash-dumps', 'logs']) fs.mkdirSync(path.join(runtime, folder), { recursive: true });
app.setPath('userData', path.join(runtime, 'electron'));
app.setPath('sessionData', path.join(runtime, 'electron', 'sessions'));
app.setPath('crashDumps', path.join(runtime, 'electron', 'crash-dumps'));
app.setAppLogsPath(path.join(runtime, 'logs'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'ice', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window;
let python;
let shuttingDown = false;
let nextId = 0;
const pending = new Map();
const methods = new Set(['bootstrap', 'brief.suggest', 'jobs.list', 'jobs.create', 'jobs.get', 'jobs.resume', 'jobs.stop',
  'approvals.decide', 'approvals.edit', 'articles.save', 'articles.finalize', 'assets.select', 'assets.preview',
  'execution.approve', 'execution.inputs', 'claims.verify', 'models.save', 'models.probe', 'library.list', 'library.read']);
for (const method of ['accounts.save','accounts.switch','accounts.export','resources.list','resources.preview','resources.analyze','resources.apply','resources.use','drafts.list','drafts.get','drafts.save','history.list','history.get','history.update','history.progress','planning.context','planning.propose','planning.confirm']) methods.add(method);

function pythonExecutable() {
  const candidates = [process.env.ICE_PYTHON, path.join(project, '.venv', 'Scripts', 'python.exe')];
  const root = path.join(project, '.tools', 'python');
  if (fs.existsSync(root)) for (const folder of fs.readdirSync(root)) candidates.push(path.join(root, folder, 'python.exe'));
  return candidates.find(file => file && fs.existsSync(file) && fs.statSync(file).isFile());
}

function request(method, params = {}) {
  if (!python || python.killed || !python.stdin.writable) return Promise.reject(new Error('文章引擎尚未连接，请重新启动工作台'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请检查任务状态后重试')); }, 135000);
    pending.set(id, { resolve, reject, timer });
    python.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('引擎连接中断')); }
    });
  });
}

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame.url.split('#')[0] !== 'ice://app/index.html') {
    throw new Error('无效的窗口请求');
  }
}

function readKeys() {
  const file = path.join(runtime, 'credentials.json');
  if (!fs.existsSync(file)) return {};
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，已保留加密凭据，请使用环境变量配置');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = {};
  for (const [provider, value] of Object.entries(stored)) keys[provider] = safeStorage.decryptString(Buffer.from(value, 'base64'));
  return keys;
}

async function startEngine() {
  const executable = pythonExecutable();
  if (!executable) throw new Error('找不到 Python 3.12+。请运行项目的安装脚本，或设置 ICE_PYTHON 指向解释器。');
  const args = ['-m', 'ice_agent.desktop_service', '--project-root', project, '--runtime-root', runtime];
  if (process.argv.includes('--smoke')) args.push('--article-root', path.join(runtime, 'articles'));
  python = spawn(executable, args, {
    cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });
  readline.createInterface({ input: python.stdout }).on('line', line => {
    try {
      const response = JSON.parse(line);
      const entry = pending.get(response.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(response.id);
      if (response.error) entry.reject(new Error(response.error.message)); else entry.resolve(response.result);
    } catch { /* A protocol error must never become renderer HTML. */ }
  });
  python.stderr.on('data', data => {
    fs.appendFileSync(path.join(runtime, 'sidecar.log'), data);
  });
  const exited = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('文章引擎已退出，请重启工作台')); }
    pending.clear();
    if (!shuttingDown && window && !window.isDestroyed()) window.webContents.send('ice:engine-exit');
  };
  python.on('exit', exited); python.on('error', exited);
  const keys = readKeys();
  if (Object.keys(keys).length) await request('secrets.set', { keys });
  await request('bootstrap');
}

function registerIPC() {
  ipcMain.handle('ice:capture-window', async event => {
    assertSender(event);
    const folder = path.join(runtime, 'screenshots');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'studio-' + Date.now() + '.png');
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(file, screenshot.toPNG());
    return { file };
  });
  ipcMain.handle('ice:request', (event, method, params) => {
    assertSender(event);
    if (!methods.has(method) || typeof params !== 'object' || params === null || JSON.stringify(params).length > 500000) throw new Error('无效请求');
    return request(method, params);
  });
  ipcMain.handle('ice:import-image', async (event, jobId, figureNo) => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: `导入图 ${figureNo}`, properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (choice.canceled) return null;
    return request('assets.import', { job_id: jobId, figure_no: figureNo, file_path: choice.filePaths[0] });
  });
  ipcMain.handle('ice:import-publication', async event => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '导入公众号配置或品牌说明', properties: ['openFile'], filters: [{ name: '配置与文档', extensions: ['json','md','txt'] }] });
    if (choice.canceled) return null;
    const file = choice.filePaths[0];
    if (fs.statSync(file).size > 128000) throw Error('文件过大，请使用小于128KB的配置或品牌说明');
    return request('accounts.import', { text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), format: path.extname(file).slice(1).toLowerCase(), name: path.basename(file, path.extname(file)) });
  });
  ipcMain.handle('ice:export-publication', async event => {
    assertSender(event);
    const bundle = await request('accounts.export');
    const choice = await dialog.showSaveDialog(window, { title: '导出公众号配置', defaultPath: path.join(runtime, 'publication-profile.json'), filters: [{ name: 'JSON配置', extensions: ['json'] }] });
    if (choice.canceled) return null;
    fs.writeFileSync(choice.filePath, JSON.stringify(bundle, null, 2));
    return { file: choice.filePath };
  });
  ipcMain.handle('ice:import-resource', async event => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '导入配图资源', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png','jpg','jpeg','webp'] }] });
    if (choice.canceled) return null;
    return request('resources.import', { file_path: choice.filePaths[0] });
  });
  ipcMain.handle('ice:import-draft', async event => {
    assertSender(event);
    const choice = await dialog.showOpenDialog(window, { title: '导入文章草稿', properties: ['openFile'], filters: [{ name: 'Markdown与文本', extensions: ['md','txt'] }] });
    if (choice.canceled) return null;
    const file = choice.filePaths[0];
    if (fs.statSync(file).size > 600000) throw Error('草稿文件过大，请使用小于600KB的文本');
    return request('drafts.save', { title: path.basename(file, path.extname(file)), body: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') });
  });
  ipcMain.handle('ice:export-draft', async (event, draftId) => {
    assertSender(event);
    const draft = await request('drafts.get', { draft_id: draftId });
    const choice = await dialog.showSaveDialog(window, { title: '导出草稿', defaultPath: path.join(runtime, 'draft.md'), filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (choice.canceled) return null;
    fs.writeFileSync(choice.filePath, draft.body);
    return { file: choice.filePath };
  });
  ipcMain.handle('ice:save-key', async (event, provider, key) => {
    assertSender(event);
    if (!['qwen', 'deepseek', 'kimi', 'bigmodel', 'ark'].includes(provider) || typeof key !== 'string' || key.length > 4096) throw new Error('凭据无效');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，请改用环境变量配置');
    const file = path.join(runtime, 'credentials.json');
    const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (key) stored[provider] = safeStorage.encryptString(key).toString('base64'); else delete stored[provider];
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(stored)); fs.renameSync(temporary, file);
    await request('secrets.set', { keys: { [provider]: key } });
    return { ok: true };
  });
  ipcMain.handle('ice:open-folder', async (event, jobId) => {
    assertSender(event);
    const data = await request('jobs.get', { job_id: jobId });
    const folder = data.export.folder;
    if (!folder || !fs.existsSync(folder)) throw new Error('文章尚未导出');
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
    return { ok: true };
  });
  ipcMain.handle('ice:tapnow', event => {
    assertSender(event);
    const browser = new BrowserWindow({ width: 1280, height: 860, title: 'TapNow · ICE Loop',
      webPreferences: { partition: 'persist:tapnow', nodeIntegration: false, contextIsolation: true, sandbox: true } });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browser.loadURL('https://app.tapnow.media');
    return { ok: true };
  });
}

async function createWindow() {
  window = new BrowserWindow({ width: 1460, height: 940, minWidth: 1040, minHeight: 720,
    title: 'ICE Loop Studio', backgroundColor: '#F3F2ED', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: !process.argv.includes('--smoke') } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('ice://app/')) event.preventDefault(); });
  window.once('ready-to-show', () => { if (!process.argv.includes('--smoke')) window.show(); });
  await window.loadURL('ice://app/index.html');
  if (process.argv.includes('--smoke')) {
    setTimeout(async () => {
      try {
        const result = await window.webContents.executeJavaScript('window.__ICE_SMOKE__()');
        fs.writeFileSync(path.join(runtime, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
        await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__("studio")');
        await new Promise(resolve => setTimeout(resolve, 350));
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        result.nativeScreenshot = await window.webContents.executeJavaScript('window.ice.captureWindow()');
        const image = await window.webContents.capturePage();
        fs.writeFileSync(path.join(runtime, 'desktop-preview.png'), image.toPNG());
        for (const view of ['models','article']) {
          await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__(' + JSON.stringify(view) + ')');
          await new Promise(resolve => setTimeout(resolve, 150));
          const capture = await window.webContents.capturePage();
          fs.writeFileSync(path.join(runtime, 'desktop-' + view + '.png'), capture.toPNG());
        }
        window.setSize(1040, 800);
        await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__("studio")');
        await new Promise(resolve => setTimeout(resolve, 350));
        result.compact = await window.webContents.executeJavaScript('({bodyWidth:document.body.scrollWidth, viewport:innerWidth, heading:document.querySelector("h1").textContent})');
        const compact = await window.webContents.capturePage();
        fs.writeFileSync(path.join(runtime, 'desktop-compact.png'), compact.toPNG());
        window.setSize(1460, 1000);
        result.publications = await window.webContents.executeJavaScript('window.__ICE_PUBLICATION_SMOKE__()');
        result.planning = await window.webContents.executeJavaScript('window.__ICE_PLANNING_SMOKE__()');
        await request('resources.import', {file_path:result.nativeScreenshot.file});
        result.resources = await window.webContents.executeJavaScript('window.__ICE_RESOURCE_SMOKE__()');
        for (const view of ['accounts','drafts','resources','history','new']) {
          await window.webContents.executeJavaScript('window.__ICE_CAPTURE_VIEW__(' + JSON.stringify(view) + ')');
          await new Promise(resolve=>setTimeout(resolve,250));
          const actual = await window.webContents.executeJavaScript('({view:ui.view,heading:document.querySelector("h1")?.textContent,form:Boolean(document.querySelector("#account-form"))})');
          if (view === 'accounts' && !actual.form) throw Error('公众号设置页面未渲染：'+JSON.stringify(actual));
          await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
          const capture = await window.webContents.capturePage(); fs.writeFileSync(path.join(runtime,'desktop-'+view+'.png'),capture.toPNG());
        }
        fs.writeFileSync(path.join(runtime, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
        app.quit();
      } catch (error) { fs.writeFileSync(path.join(runtime, 'desktop-smoke-error.txt'), error.message); app.quit(); }
    }, 1800);
  }
}

app.whenReady().then(async () => {
  protocol.handle('ice', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('not found', { status: 404 });
    const root = path.join(__dirname, 'renderer');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  registerIPC();
  try { await startEngine(); await createWindow(); }
  catch (error) {
    if (process.argv.includes('--smoke')) fs.writeFileSync(path.join(runtime, 'desktop-smoke-error.txt'), error.message);
    else dialog.showErrorBox('ICE Loop 启动失败', error.message);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('before-quit', () => {
  shuttingDown = true;
  if (python && !python.killed) { python.stdin.end(); setTimeout(() => python.kill(), 1000).unref(); }
});
