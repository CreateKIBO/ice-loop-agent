// v3.23–v3.25 公众号草稿箱界面：封面裁切、多图文对话框（顺序、移出、冲突覆盖）、编辑器里“所在多图文”。
// 真实 React UI + 内存 RPC；不是 Electron IPC，不访问微信。
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild'), { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/wechat-browser'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Real UI / offline memory RPC; no Electron, WeChat API or personal data', checks: {}, errors: [] };
let server, browser, page;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';
    import{accountStore,queryClient}from'./data/client';import{Toaster}from'./components/toast';
    import{WeChatGroupDialog}from'./features/documents/WeChatGroupDialog';
    import{WeChatDraftPanel}from'./features/documents/WeChatDraftPanel';
    import{CoverCrop}from'./features/documents/CoverCrop';
    import './styles/tokens.css';import './styles/documents.css';
    queryClient.setDefaultOptions({queries:{retry:false}});accountStore.set('wx-fixture');
    const titles={'doc-a':'头条文章','doc-b':'第二篇','doc-c':'没有封面'};
    window.calls=[];window.syncResults=[];
    window.ice={request:async(method,p)=>{
      window.calls.push({method,p:structuredClone(p)});
      if(method==='wechat.status')return {configured:true,appid:'wx1234567890abcdef',secret_set:true,last_check_at:null,last_check_ok:null,last_check_message:'',
        draft:null,unknown_operation:null,groups:p.document_id?[{group_key:'g1',media_id:'MEDIA-GROUP-123456',synced_at:'2026-11-08T03:00:00Z',position:2,
          document_ids:['doc-a','doc-b'],current:false,members:[{document_id:'doc-a',title:'头条文章',available:true},{document_id:'doc-b',title:'第二篇',available:true}]}]:undefined};
      if(method==='wechat.group_preview')return {ready:!p.document_ids.includes('doc-c'),configured:true,secret_set:true,unknown_operation:null,
        group:p.document_ids.join()==='doc-a,doc-b'?{media_id:'MEDIA-GROUP-123456',synced_at:'2026-11-08T03:00:00Z',current:false}:null,
        items:p.document_ids.map(id=>({document_id:id,title:titles[id],version_id:'v-'+id,version_created_at:'2026-11-08T02:00:00Z',
          unversioned:id==='doc-b',problem:id==='doc-c'?'没有封面：在“文章设置”里指定，或在正文里放一张图':''}))};
      if(method==='wechat.group_sync')return window.syncResults.shift()??{media_id:'MEDIA-NEW',action:'created',count:p.document_ids.length,warnings:[],note:'已同步'};
      if(method==='documents.image_view')return {resource_id:p.resource_id,title:'封面',width:400,height:100,mime:'image/png',size:68,ok:true,
        preview:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII='};
      if(method==='documents.list')return {documents:[],legacy:[],account_id:'wx-fixture'};
      throw Error('Unexpected method '+method);
    }};
    function Crop(){const[crop,setCrop]=React.useState(undefined);window.crop=crop;
      return <CoverCrop resourceId="resource-cover" crop={crop} onChange={value=>{window.crop=value;setCrop(value);}}/>;}
    window.done=0;
    function Group(){const[open,setOpen]=React.useState(false);
      return <><button onClick={()=>setOpen(true)}>打开多图文</button>
        {open&&<WeChatGroupDialog open documentIds={['doc-a','doc-b','doc-c']} onClose={()=>setOpen(false)} onDone={()=>{window.done++;setOpen(false);}}/>}</>;}
    createRoot(document.getElementById('root')).render(<React.StrictMode><QueryClientProvider client={queryClient}>
      <div id="crop"><Crop/></div><div id="group"><Group/></div>
      <div id="panel"><WeChatDraftPanel documentId="doc-b" versionId="v-doc-b" title="第二篇" complete onSynced={()=>{}}/></div><Toaster/>
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
  const calls = method => page.evaluate(m => window.calls.filter(c => c.method === m).map(c => c.p), method);

  // 封面裁切：4:1 的图 → 2.35:1 左右移动；1:1 也是左右移动；恢复默认清除
  const crop = page.locator('#crop');
  await crop.getByText('2.35:1 大图（默认居中）').waitFor();
  await crop.getByLabel('2.35:1 大图裁切位置').fill('0');
  let value = await page.evaluate(() => window.crop);
  assert.equal(value.for, 'resource-cover');
  assert.equal(value['235'][0], 0); assert.equal(value['235'][1], 0); assert.equal(value['235'][3], 1);
  assert.ok(Math.abs(value['235'][2] - 2.35 / 4) < 0.001);
  assert.equal(value['11'], undefined);
  await crop.getByLabel('1:1 小图裁切位置').fill('100');
  value = await page.evaluate(() => window.crop);
  assert.ok(Math.abs(value['11'][2] - 1) < 0.001 && Math.abs(value['11'][0] - 0.75) < 0.001);
  await crop.getByRole('button', { name: '恢复默认居中' }).click();
  assert.equal(await page.evaluate(() => window.crop), undefined);
  report.checks.cover_crop = true;

  // 多图文：有阻断问题的一篇让同步按钮不可用；移出后可同步；调整顺序后按新顺序提交版本
  await page.getByRole('button', { name: '打开多图文' }).click();
  const dialog = page.getByRole('dialog', { name: '合成多图文草稿' });
  await dialog.getByText('没有封面：在“文章设置”里指定').waitFor();
  await dialog.getByText('头条', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '同步为多图文草稿' }).isDisabled(), true);
  await dialog.getByText('不会带上').waitFor();  // 第二篇有未保存成版本的修改
  await dialog.getByRole('button', { name: '移出这组' }).nth(2).click();
  await dialog.getByText('同步过').waitFor();     // doc-a,doc-b 这一组以前同步过
  await dialog.getByRole('button', { name: '更新多图文草稿' }).waitFor();
  await dialog.getByRole('button', { name: '下移' }).first().click();
  await dialog.getByText('还没有同步过').waitFor();
  const button = dialog.getByRole('button', { name: '同步为多图文草稿' });
  await page.waitForFunction(() => !document.querySelector('[role=dialog] .ice-doc-group__item.is-blocked'));
  await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent === '同步为多图文草稿' && !b.disabled));
  await page.evaluate(() => { window.syncResults.push({ conflict: true, media_id: 'MEDIA-GROUP-123456', message: '后台这篇多图文被修改过' }); });
  await button.click();
  await dialog.getByText('后台草稿被修改过').waitFor();
  let syncs = await calls('wechat.group_sync');
  assert.deepEqual(syncs[0].document_ids, ['doc-b', 'doc-a']);
  assert.deepEqual(syncs[0].version_ids, ['v-doc-b', 'v-doc-a']);
  await dialog.getByRole('button', { name: '用当前版本覆盖' }).click();
  await page.waitForFunction(() => window.done === 1);
  syncs = await calls('wechat.group_sync');
  assert.equal(syncs[1].mode, 'overwrite');
  await page.getByText(/已新建多图文草稿（2 篇）/).waitFor();
  report.checks.group_dialog = true;

  // 编辑器面板：显示所在多图文，可打开这一组
  const panel = page.locator('#panel');
  await panel.getByText(/多图文第 2 篇（共 2 篇：《头条文章》《第二篇》）/).waitFor();
  await panel.getByText('这篇有新版本还没同步到这组').waitFor();
  await panel.getByRole('button', { name: '打开这组' }).click();
  const second = page.getByRole('dialog', { name: '合成多图文草稿' });
  await second.getByRole('button', { name: '更新多图文草稿' }).waitFor();
  const previews = await calls('wechat.group_preview');
  assert.deepEqual(previews.at(-1).document_ids, ['doc-a', 'doc-b']);
  report.checks.panel_groups = true;

  // 窄窗口：对话框不出现横向滚动
  await page.setViewportSize({ width: 420, height: 800 });
  const overflow = await second.evaluate(el => el.scrollWidth > el.clientWidth + 1);
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
