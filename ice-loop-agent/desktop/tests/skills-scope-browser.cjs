// v3.16 技能组合与作用域：设置里的辅助技能、技能类型、系列设置；编辑器“本篇技能”。真实 React UI + 内存 RPC；不是 Electron IPC。
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild'), { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/skills-scope'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Real UI / offline memory RPC; no Electron, paid models or personal data', checks: {}, errors: [] };
let server, browser, page;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';
    import{SkillSettingsHost}from'./app/SkillSettingsHost';import{skillSettingsStore}from'./app/uiState';
    import{accountStore,queryClient}from'./data/client';import{Toaster}from'./components/toast';
    import{DocumentSkillChip}from'./features/documents/DocumentSkills';import{ConversationSkillChip}from'./features/chat/ConversationSkills';
    queryClient.setDefaultOptions({queries:{retry:false}});accountStore.set('scope-fixture');
    window.saved={account_id:'scope-fixture',revision:0,state_hash:'v0',active_skill_id:'ice-writing',active_addon_ids:[],series_bindings:{},skills:[
      {id:'ice-writing',name:'ICE 写作方法',instructions:'以具体例子解释技术。',rules:{},version:1,kind:'main'},
      {id:'story',name:'故事写法',instructions:'用一个人物贯穿。',rules:{},version:1,kind:'main'},
      {id:'titles',name:'标题策略',instructions:'给三个备选标题。',rules:{title_max_chars:26},version:1,kind:'main'}]};
    window.bindings=[];window.binding=null;
    const brief=s=>({id:s.id,name:s.name,version:s.version,kind:s.kind});
    const preview=b=>{const sk=Object.fromEntries(window.saved.skills.map(s=>[s.id,s]));
      const main=b&&('main' in b)?(b.main?sk[b.main]:null):sk[window.saved.active_skill_id];
      const addons=(b&&('addons' in b)?b.addons:window.saved.active_addon_ids).map(id=>sk[id]);
      return {main:main?brief(main):null,addons:addons.map(brief),scope:{main:b&&('main' in b)?'document':'account',addons:b&&('addons' in b)?'document':'account'},
        rule_count:1,conflicts:[],notices:[],series:null,binding:b,context:'document'};};
    window.convBindings=[];window.convBinding=null;
    window.ice={request:async(method,params)=>{
      if(method==='skills.get')return structuredClone(window.saved);
      if(method==='skills.save'){window.saved={...params,revision:window.saved.revision+1,state_hash:'v'+(window.saved.revision+1)};return structuredClone(window.saved);}
      if(method==='documents.list')return {documents:[{series:'周刊'},{series:null}],legacy:[],account_id:'scope-fixture'};
      if(method==='skills.resolve'&&params.conversation_id)return {...preview('binding' in params?params.binding:window.convBinding),context:'conversation'};
      if(method==='skills.resolve')return preview('binding' in params?params.binding:window.binding);
      if(method==='skills.conversation_binding'){window.convBindings.push(params);window.convBinding=params.binding;return {...preview(params.binding),context:'conversation'};}
      if(method==='documents.skill_binding'){window.bindings.push(params.binding);window.binding=params.binding;return preview(params.binding);}
      if(method==='documents.get')return {};
      if(method==='skills.check_conflicts'){window.checked=params.skills;return {method:'rules',skills:params.skills.map(s=>({id:s.id,name:s.name})),checked:['叙述人称'],
        conflicts:[{kind:'text',dimension:'person',label:'叙述人称',advice:'两个技能要求相反',items:[
          {skill_id:'ice-writing',skill_name:'ICE 写作方法',quote:'用第一人称讲述。',pole:'first',pole_label:'第一人称'},
          {skill_id:'titles',skill_name:'标题策略',quote:'不要用第一人称。',pole:'third',pole_label:'不用第一人称'}]}]};}
      throw Error('Unexpected method '+method);
    }};
    createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={queryClient}>
      <button onClick={()=>skillSettingsStore.set(true)}>打开技能</button><SkillSettingsHost/>
      <div id="conv"><ConversationSkillChip conversationId="conv-1" /></div>
      <div id="chip"><DocumentSkillChip documentId="doc-1" binding={null} generated={[{name:'ICE 写作方法',version:1,kind:'main'}]} /></div><Toaster/>
    </QueryClientProvider></React.StrictMode>);
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(folder, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(folder, req.url.slice(1)))); }
    else { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  page = await browser.newPage({ viewport: { width: 1160, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);

  // 本篇技能：编辑器顶栏显示，改为本篇专用
  const chip = page.getByRole('button', { name: /本篇技能：ICE 写作方法/ });
  await chip.waitFor(); report.checks.chip_shows_account_default = true;
  await chip.click();
  const docDialog = page.getByRole('dialog', { name: '本篇写作技能', exact: true });
  await docDialog.getByText('生成初稿时使用：ICE 写作方法 v1').waitFor();
  await docDialog.getByLabel('主技能', { exact: true }).selectOption('story');
  await docDialog.getByText(/来自本篇设置/).first().waitFor();
  await docDialog.getByRole('button', { name: '保存本篇设置', exact: true }).click();
  await page.waitForFunction(() => window.bindings.length === 1);
  assert.deepEqual(await page.evaluate(() => window.bindings[0]), { main: 'story' });
  await page.getByRole('button', { name: /本篇技能：故事写法/ }).waitFor(); report.checks.document_binding_saved = true;

  // v3.17 会话技能：助手会话顶部的标签与对话框
  await page.getByRole('button', { name: /本会话技能：ICE 写作方法/ }).click();
  const convDialog = page.getByRole('dialog', { name: '本会话写作技能', exact: true });
  await convDialog.getByLabel('主技能', { exact: true }).selectOption('__none__');
  await convDialog.getByText(/来自本会话设置/).first().waitFor();
  await convDialog.getByRole('button', { name: '保存本会话设置', exact: true }).click();
  await page.waitForFunction(() => window.convBindings.length === 1);
  assert.deepEqual(await page.evaluate(() => window.convBindings[0]), { account_id: 'scope-fixture', conversation_id: 'conv-1', binding: { main: null } });
  await page.getByRole('button', { name: /本会话技能：不使用主技能/ }).waitFor(); report.checks.conversation_binding_saved = true;

  // 设置：把“标题策略”改为辅助技能并勾选；添加系列设置
  await page.getByRole('button', { name: '打开技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '写作技能', exact: true });
  await dialog.getByRole('button', { name: '编辑标题策略', exact: true }).click();
  await dialog.getByLabel('技能类型', { exact: true }).selectOption('addon');
  assert.equal(await dialog.getByRole('radio', { name: /标题策略/ }).count(), 0);
  await dialog.getByRole('checkbox', { name: /标题策略/ }).check();
  // v3.20 冲突检查：检查的是编辑中的组合（含未保存的类型与勾选）
  await dialog.getByRole('button', { name: '检查冲突', exact: true }).click();
  await dialog.getByText('不要用第一人称。').waitFor();
  assert.deepEqual(await page.evaluate(() => window.checked.map(s => [s.id, s.kind])), [['ice-writing', 'main'], ['titles', 'addon']]);
  report.checks.conflict_check_uses_draft = true;
  await dialog.getByRole('button', { name: /按系列设置/ }).click();
  await dialog.getByLabel('新增系列名', { exact: true }).fill('周刊');
  await dialog.getByRole('button', { name: '添加系列', exact: true }).click();
  await dialog.getByLabel('系列「周刊」的主技能', { exact: true }).selectOption('story');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 1);
  const saved = await page.evaluate(() => window.saved);
  assert.equal(saved.skills.find(s => s.id === 'titles').kind, 'addon');
  assert.deepEqual(saved.active_addon_ids, ['titles']);
  assert.deepEqual(saved.series_bindings, { '周刊': { main: 'story' } });
  report.checks.addon_and_series_saved = true;

  // 移除辅助技能时，引用一并去掉（否则后端会拒绝）
  await dialog.getByRole('button', { name: '编辑标题策略', exact: true }).click();
  await dialog.getByRole('button', { name: '移除此技能（保存后生效）', exact: true }).click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 2);
  assert.deepEqual(await page.evaluate(() => window.saved.active_addon_ids), []); report.checks.remove_drops_references = true;

  await page.setViewportSize({ width: 390, height: 560 });
  const overflow = await dialog.evaluate(el => [el, el.querySelector('.ice-dialog-body'), el.querySelector('fieldset')].some(node => node && node.scrollWidth > node.clientWidth + 1));
  assert.equal(overflow, false); report.checks.narrow_no_overflow = true;
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
