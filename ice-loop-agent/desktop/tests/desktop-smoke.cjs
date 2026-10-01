const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', '..');
const runtime = path.join(root, '.test-tmp', 'electron-' + Date.now());
fs.mkdirSync(runtime, { recursive: true });
const child = spawn(require('electron'), [path.join(root, 'desktop'), '--smoke'], {
  cwd: root, windowsHide: true, env: {...process.env, ICE_DESKTOP_RUNTIME: runtime}, stdio: 'pipe'
});
let errorText = '';
child.stderr.on('data', data => errorText += data);
const timer = setTimeout(() => { child.kill(); console.error('Desktop test timeout', runtime); process.exitCode = 1; }, 140000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  try {
    const errorFile = path.join(runtime, 'desktop-smoke-error.txt');
    if (fs.existsSync(errorFile)) throw Error(fs.readFileSync(errorFile, 'utf8'));
    const result = JSON.parse(fs.readFileSync(path.join(runtime, 'desktop-smoke.json'), 'utf8'));
    assert.equal(code, 0); assert.equal(result.connected, true); assert.equal(result.previewEscaped, true);
    assert.equal(result.completed, true); assert.equal(result.exported, true); assert.equal(result.runs, 3);
    assert.deepEqual(result.gates, ['topic', 'outline', 'final_title', 'asset_plan']);
    assert.equal(result.modelCards, 5); assert.equal(result.evidenceCards, 3);
    assert.equal(result.bodyWidth, result.viewport);
    assert.equal(result.compact.bodyWidth, result.compact.viewport);
    assert.equal(result.compact.heading, '从一个想法，到一篇好文章。');
    assert.equal(result.navigationStable, true);
    for (const key of ['filled','editable','protectedEdit','noTask','customColumn','draftSaved','isolated','restored']) assert.equal(result.publications[key],true,key);
    for(const key of ['nextEpisode','manualEpisodeProtected','protectedTitle','candidates','adopted','confirmed','staleIgnored','historyPage','noTask']) assert.equal(result.planning[key],true,key);
    assert.equal(result.resources.cards,1); assert.ok(result.resources.palette>0);
    assert.equal(result.resources.measured,true); assert.equal(result.resources.preview,true);
    assert.ok(fs.statSync(result.nativeScreenshot.file).size > 1000);
    console.log(JSON.stringify({runtime, ...result}, null, 2));
  } catch (error) { console.error(error.message, errorText.slice(-1500), runtime); process.exitCode = 1; }
});
