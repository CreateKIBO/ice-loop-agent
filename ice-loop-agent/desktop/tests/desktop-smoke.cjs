const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', '..');
const runtime = path.join(process.env.ICE_TEST_RUNTIME_BASE||path.join(root,'.test-tmp'), 'electron-' + Date.now());
fs.mkdirSync(runtime, { recursive: true });
const packaged=process.env.ICE_TEST_EXECUTABLE;
const testEnv={...process.env,ICE_DESKTOP_RUNTIME:runtime};
if(packaged){testEnv.PATH=path.join(process.env.SystemRoot,'System32');for(const key of ['ICE_PYTHON','ICE_TEACHING_PYTHON','PYTHONPATH','VIRTUAL_ENV','NODE_PATH'])delete testEnv[key];}
const child = spawn(packaged||require('electron'), packaged?['--smoke']:[path.join(root, 'desktop'), '--smoke'], {
  cwd: packaged?path.dirname(packaged):root, windowsHide: true, env:testEnv, stdio: 'pipe'
});
let errorText = '';
child.stderr.on('data', data => errorText += data);
const timer = setTimeout(() => { child.kill(); console.error('Desktop test timeout', runtime); process.exitCode = 1; }, 600000);
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
    assert.equal(result.modelCards, 6); assert.equal(result.evidenceCards, 3);
    assert.equal(result.bodyWidth, result.viewport);
    assert.equal(result.compact.bodyWidth, result.compact.viewport);
    assert.equal(result.compact.heading, '从一个想法，到一篇好文章。');
    assert.equal(result.navigationStable, true);
    for (const key of ['filled','editable','protectedEdit','noTask','customColumn','draftSaved','isolated','restored']) assert.equal(result.publications[key],true,key);
    for(const key of ['nextEpisode','manualEpisodeProtected','protectedTitle','candidates','adopted','confirmed','staleIgnored','historyPage','noTask']) assert.equal(result.planning[key],true,key);
    assert.equal(result.resources.cards,1); assert.ok(result.resources.palette>0);
    assert.equal(result.resources.measured,true); assert.equal(result.resources.preview,true);
    for(const key of ['editable','searchable','filterWorks','tapnowEntry'])assert.equal(result.resources[key],true,key);
    assert.equal(result.runCapture.valid,true);assert.equal(result.runCapture.source,'run_capture');assert.equal(result.runCapture.resource,true);
    assert.ok(fs.statSync(result.runCapture.file).size>1000);
    assert.equal(result.promptReady,true);assert.ok(result.promptCopied||result.promptCopyFallback,'actual copy or visible manual fallback');assert.equal(result.visionPanel,true);
    assert.equal(result.resourcePipeline.ready,true);assert.equal(result.resourcePipeline.slots,4);
    for(const key of ['saved','diff','restored','historyUI','diffUI','htmlEntry','backup','packageChecked','restore','restart','htmlRendered'])assert.equal(result.maintenance[key],true,key);
    for(const key of ['readonly','manualTapNow','planEdited','rejected','reaccepted','cleared','actualRun','screenshot','resourceReuse','noModelCalls','stillNeedsTextReview','originalPreserved','textPreserved','promptExported','compact'])assert.equal(result.supplements[key],true,key);
    assert.ok(fs.statSync(result.supplements.screenshot_file).size>1000);
    assert.ok(fs.statSync(result.nativeScreenshot.file).size > 1000);
    for(const key of ['sample','preview','editable','saved','overTen','issueHundred','confirmed','titleProtected','sourceSwitchProtected','noTask','compact','isolated','restored','pageCaptureReady','formCaptureReady'])assert.equal(result.outlines[key],true,key);
    for(const key of ['conflictDetected','conflictResolved','coverUI','coverMetadata','crop','reminder','richContentReady','articleCapture','singleSlotRedo','diagnostics','toolsUI','compact'])assert.equal(result.productionTools[key],true,key);
    assert.ok(result.productionTools.richClipboard&&result.productionTools.clipboardHTML||result.productionTools.clipboardFallback,'actual rich copy or visible manual fallback');
    for(const key of ['twoFolders','markdown','imagesOnly','linksResolved','archiveSeparate','manualInstructions'])assert.equal(result.publicationExport[key],true,key);
    console.log(JSON.stringify({runtime, ...result}, null, 2));
  } catch (error) { console.error(error.message, errorText.slice(-1500), runtime); process.exitCode = 1; }
});
