// v3.15 写作技能导入/导出/版本历史/恢复预装：真实 React UI + 内存 RPC 夹具；不是 Electron IPC。
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild'), { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/skills-packages'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Real UI / offline memory RPC; no Electron, paid models or personal data', checks: {}, errors: [] };
let server, browser, page;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';
    import{SkillSettingsHost}from'./app/SkillSettingsHost';import{skillSettingsStore}from'./app/uiState';
    import{accountStore,queryClient}from'./data/client';import{Toaster}from'./components/toast';
    queryClient.setDefaultOptions({queries:{retry:false}});accountStore.set('pkg-fixture');
    const ice={id:'ice-writing',name:'ICE 写作方法',instructions:'以具体例子解释技术。',rules:{numbered_headings:true}};
    window.saved={account_id:'pkg-fixture',revision:0,state_hash:'v0',active_skill_id:'ice-writing',skills:[{...ice,version:2}]};
    window.calls=[];window.exported=[];
    window.ice={
      exportSkill:async params=>{window.exported.push(params);return {file:'/tmp/'+params.skill_id+'.md'};},
      request:async(method,params)=>{
        window.calls.push(method);
        if(method==='skills.get')return structuredClone(window.saved);
        if(method==='skills.save'){
          if(params.state_hash!==window.saved.state_hash)throw Error('stale fixture write');
          window.saved={...params,skills:params.skills.map(s=>({...s,version:s.version||1})),revision:window.saved.revision+1,state_hash:'v'+(window.saved.revision+1)};
          return structuredClone(window.saved);
        }
        if(method==='skills.import_parse'){
          if(!params.data_base64||params.file_name!=='随笔.md')throw Error('unexpected import');
          return {skill:{name:'随笔方法',instructions:'用三个细节写一件小事。',rules:{title_max_chars:30},
            source:{kind:'import',file_name:'随笔.md',imported_at:'2026-11-08T10:00:00',format:'markdown',sha256:'h'}},
            warnings:['以下声明不会生效：allowed-tools（技能只影响写作与检查，不授予工具、模型或文件权限）'],ignored_files:['scripts/run.py']};
        }
        if(method==='skills.versions')return {skill_id:params.skill_id,installed:true,versions:[
          {version:2,name:'ICE 写作方法',chars:10,rule_count:1,created_at:'2026-11-08T09:00:00',source:null,current:true},
          {version:1,name:'ICE 写作方法',chars:8,rule_count:0,created_at:'2026-11-01T09:00:00',source:null,current:false}]};
        if(method==='skills.version')return {skill_id:params.skill_id,version:params.version,name:'ICE 写作方法',instructions:'第一版：先讲故事。',rules:{},source:null,created_at:'2026-11-01T09:00:00'};
        if(method==='skills.defaults')return {skills:[{id:'general-writing',name:'通用写作',instructions:'按读者需要写作。',rules:{}},ice]};
        throw Error('Unexpected method '+method);
      }};
    createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={queryClient}>
      <button onClick={()=>skillSettingsStore.set(true)}>打开技能</button><SkillSettingsHost/><Toaster/>
    </QueryClientProvider></React.StrictMode>);
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(folder, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(folder, req.url.slice(1)))); }
    else { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  page = await browser.newPage({ viewport: { width: 1160, height: 860 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: '打开技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '写作技能', exact: true });
  await dialog.getByLabel('写作指令', { exact: true }).waitFor();
  assert.ok(!(await page.evaluate(() => window.calls)).includes('skills.versions')); report.checks.history_is_lazy = true;

  // 导入：解析 → 预览（提示、未导入文件）→ 加入列表 → 保存后带来源
  await page.getByLabel('选择技能文件').setInputFiles({ name: '随笔.md', mimeType: 'text/markdown', buffer: Buffer.from('# 随笔\n写小事') });
  const importDialog = page.getByRole('dialog', { name: '导入写作技能', exact: true });
  await importDialog.getByText(/allowed-tools/).waitFor();
  await importDialog.getByText(/scripts\/run\.py/).waitFor();
  await importDialog.getByRole('button', { name: '加入技能列表', exact: true }).click();
  await dialog.getByRole('radio', { name: /随笔方法/ }).waitFor();
  assert.equal(await dialog.getByLabel('写作指令', { exact: true }).inputValue(), '用三个细节写一件小事。');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 1);
  const imported = await page.evaluate(() => window.saved.skills.find(s => s.name === '随笔方法'));
  assert.match(imported.id, /^imported-/); assert.equal(imported.source.file_name, '随笔.md'); assert.deepEqual(imported.rules, { title_max_chars: 30 });
  report.checks.import_preview_then_save = true;

  // 复制为新技能
  await dialog.getByRole('button', { name: '编辑ICE 写作方法', exact: true }).click();
  await dialog.getByRole('button', { name: '复制为新技能', exact: true }).click();
  assert.equal(await dialog.getByLabel('技能名称', { exact: true }).inputValue(), 'ICE 写作方法 副本');
  await dialog.getByText(/复制自 ICE 写作方法 v2/).waitFor(); report.checks.copy_records_source = true;
  await dialog.getByRole('button', { name: '读取已保存设置', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃修改并读取', exact: true }).click();

  // 导出（主进程保存对话框）
  await dialog.getByRole('button', { name: '编辑ICE 写作方法', exact: true }).click();
  await dialog.getByRole('button', { name: '导出', exact: true }).click();
  await page.waitForFunction(() => window.exported.length === 1);
  assert.deepEqual(await page.evaluate(() => window.exported[0]), { account_id: 'pkg-fixture', skill_id: 'ice-writing' });
  report.checks.export_via_main = true;

  // 版本历史：查看 v1、载入到编辑区（未保存）
  await dialog.getByRole('button', { name: '版本历史', exact: true }).click();
  await dialog.getByRole('button', { name: 'v1', exact: true }).click();
  await dialog.getByText('第一版：先讲故事。').waitFor();
  await dialog.getByRole('button', { name: '载入 v1 到编辑区', exact: true }).click();
  assert.equal(await dialog.getByLabel('写作指令', { exact: true }).inputValue(), '第一版：先讲故事。');
  assert.equal(await page.evaluate(() => window.saved.revision), 1); report.checks.history_load_is_unsaved_draft = true;
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 2);
  assert.deepEqual(await page.evaluate(() => window.saved.skills.find(s => s.id === 'ice-writing').source), { kind: 'restore', from_version: 1 });
  report.checks.history_restore_saves_with_source = true;

  // 恢复预装：缺少的可重新加入，不自动启用
  await dialog.getByRole('button', { name: '恢复预装技能', exact: true }).click();
  const restore = page.getByRole('dialog', { name: '恢复预装技能', exact: true });
  await restore.getByRole('button', { name: '重新加入', exact: true }).click();
  await dialog.getByRole('radio', { name: /通用写作/ }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: /通用写作/ }).isChecked(), false); report.checks.restore_default_not_activated = true;

  await page.setViewportSize({ width: 390, height: 520 });
  const overflow = await dialog.evaluate(el => [el, el.querySelector('.ice-dialog-body'), el.querySelector('fieldset')].some(node => node && node.scrollWidth > node.clientWidth + 1));
  assert.equal(overflow, false); report.checks.narrow_no_overflow = true;
  await page.screenshot({ path: path.join(folder, 'skills-packages-narrow.png'), fullPage: true });
  assert.deepEqual(report.errors, []);
}
run().catch(async error => {
  report.failure = error.stack; process.exitCode = 1;
  if (page) { report.body = await page.locator('body').innerText().catch(() => 'unavailable'); await page.screenshot({ path: path.join(folder, 'failure.png'), fullPage: true }).catch(() => {}); }
}).finally(async () => {
  await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ folder, ...report }, null, 2));
});
