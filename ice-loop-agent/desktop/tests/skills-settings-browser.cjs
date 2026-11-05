// Real React/StrictMode/Radix UI with an owned memory RPC fixture; not Electron IPC.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild'), { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/skills-settings'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Real UI / offline memory RPC; no Electron, paid models or personal data', checks: {}, errors: [] };
let server, browser, page;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';
    import{SkillSettingsHost}from'./app/SkillSettingsHost';import{skillSettingsStore}from'./app/uiState';
    import{accountStore,queryClient,flushAllDirty}from'./data/client';import{Toaster}from'./components/toast';
    queryClient.setDefaultOptions({queries:{retry:false}});accountStore.set('skills-fixture');
    const seed={account_id:'skills-fixture',revision:0,state_hash:'version-0',active_skill_id:'ice-writing',skills:[
      {id:'general-writing',name:'通用写作',instructions:'按读者需要写作。',rules:{},version:1},
      {id:'ice-writing',name:'ICE 写作方法',instructions:'以具体例子解释技术。',rules:{required_ending_heading:'写在最后',brand_sentence_pattern:'可执行的想象',ending_triad:{preview_keyword:'预告'},numbered_headings:true},version:1}]};
    window.saved=structuredClone(seed);window.writes=[];window.gets=0;window.failGet=false;window.failSave=false;window.holdSave=false;
    window.ice={request:async(method,params)=>{
      if(method==='skills.get'){window.gets++;if(window.failGet)throw Error('owned read failed');return structuredClone(window.saved);}
      if(method==='skills.save'){
        window.writes.push(structuredClone(params));if(window.failSave)throw Error('技能已在其他窗口修改，请重新读取并核对');
        if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);
        if(params.account_id!==window.saved.account_id||params.state_hash!==window.saved.state_hash)throw Error('stale fixture write');
        window.saved={...params,revision:window.saved.revision+1,state_hash:'version-'+(window.saved.revision+1)};return structuredClone(window.saved);
      }throw Error('Unexpected method '+method);
    }};
    window.tryNavigation=()=>flushAllDirty().then(()=>true,error=>error.message);
    createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={queryClient}>
      <button onClick={()=>skillSettingsStore.set(true)}>打开技能</button><SkillSettingsHost/><Toaster/>
    </QueryClientProvider></React.StrictMode>);
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(folder, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(folder, req.url.slice(1)))); }
    else { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  page = await browser.newPage({ viewport: { width: 1160, height: 820 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: '打开技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '写作技能', exact: true });
  await dialog.getByLabel('写作指令', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: /ICE 写作方法/ }).isChecked(), true); report.checks.default_selected = true;
  await dialog.getByLabel('写作指令', { exact: true }).fill('我的技能：以观察、故事和结论组织文章。');
  await dialog.getByLabel('固定结尾标题（留空不要求）', { exact: true }).fill('');
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 1);
  let saved = await page.evaluate(() => window.saved);
  assert.equal(saved.skills[1].instructions, '我的技能：以观察、故事和结论组织文章。');
  assert.equal(saved.skills[1].rules.brand_sentence_pattern, ''); assert.deepEqual(saved.skills[1].rules.ending_triad, {});
  report.checks.edit_and_clear_ending_rules = true;
  await dialog.getByRole('radio', { name: '不使用额外技能', exact: true }).check();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 2);
  assert.equal(await page.evaluate(() => window.saved.active_skill_id), null); report.checks.disable_skill = true;
  await dialog.getByLabel('写作指令', { exact: true }).fill('尚未保存的内容');
  assert.match(await page.evaluate(() => window.tryNavigation()), /未保存/); report.checks.navigation_protects_unsaved = true;
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await dialog.getByLabel('写作指令', { exact: true }).inputValue(), '尚未保存的内容'); report.checks.escape_keeps_draft = true;
  await dialog.locator('summary').click();
  await dialog.getByLabel('检查规则 JSON', { exact: true }).fill('{');
  const writes = await page.evaluate(() => window.writes.length);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await dialog.getByText(/不是有效 JSON/).waitFor(); assert.equal(await page.evaluate(() => window.writes.length), writes);
  report.checks.invalid_rules_kept_without_write = true;
  await dialog.getByLabel('检查规则 JSON', { exact: true }).fill('{}');
  await page.evaluate(() => window.failSave = true);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await dialog.getByText(/其他窗口修改/).waitFor();
  assert.equal(await dialog.getByLabel('写作指令', { exact: true }).inputValue(), '尚未保存的内容'); report.checks.conflict_preserves_input = true;
  await page.evaluate(() => window.failSave = false);
  await dialog.getByRole('button', { name: '读取已保存设置', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃修改并读取', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value.startsWith('我的技能：'));
  report.checks.explicit_reload_discards_only_after_choice = true;
  await dialog.getByLabel('写作指令', { exact: true }).fill('等待保存的内容');
  await page.evaluate(() => window.holdSave = true);
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseSave === 'function');
  assert.match(await page.evaluate(() => window.tryNavigation()), /正在保存/);
  assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.holdSave = false; window.releaseSave(); });
  await page.waitForFunction(() => window.saved.revision === 3); report.checks.busy_write_blocks_navigation = true;
  await dialog.getByRole('button', { name: '移除此技能（保存后生效）', exact: true }).click();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 4);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '打开技能', exact: true }).click();
  await dialog.getByLabel('写作指令', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('radio', { name: /ICE 写作方法/ }).count(), 0); report.checks.removed_default_stays_removed = true;
  await dialog.getByRole('button', { name: '新建技能', exact: true }).click();
  await dialog.getByLabel('技能名称', { exact: true }).fill('长名称'.repeat(25));
  await dialog.getByLabel('写作指令', { exact: true }).fill('自定义风格：简洁自然。');
  await dialog.getByRole('radio', { name: new RegExp('长名称'.repeat(25)) }).check();
  await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => window.saved.revision === 5);
  assert.match(await page.evaluate(() => window.saved.active_skill_id), /^custom-/); report.checks.create_and_select_custom = true;
  await page.setViewportSize({ width: 390, height: 480 });
  await page.locator('.ice-toast__close').evaluateAll(nodes => nodes.forEach(node => node.click()));
  await page.waitForFunction(() => !document.querySelector('.ice-toast__close'));
  await dialog.getByLabel('写作指令', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(folder, 'skills-narrow.png'), fullPage: true });
  const overflow = await dialog.evaluate(el => [el, el.querySelector('.ice-dialog-body'), el.querySelector('fieldset')].some(node => node.scrollWidth > node.clientWidth + 1));
  assert.equal(overflow, false); report.checks.narrow_long_names_no_overflow = true;
  assert.deepEqual(report.errors, []);
}
run().catch(async error => {
  report.failure = error.stack; process.exitCode = 1;
  if (page) {
    report.body = await page.locator('body').innerText().catch(() => 'unavailable');
    report.debug = await page.evaluate(() => ({dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>({html:e.outerHTML.slice(0,900),hidden:e.getAttribute('aria-hidden')})),fields:[...document.querySelectorAll('textarea')].map(e=>({label:e.labels?.[0]?.textContent,html:e.outerHTML.slice(0,300)}))}));
    await page.screenshot({path:path.join(folder,'failure.png'),fullPage:true}).catch(()=>{});
  }
}).finally(async () => {
  await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ folder, ...report }, null, 2));
});
