// v3.27 布局回归：文章首页（工具收起、窄窗口）、交付侧栏不横向溢出、“多图并排”样式不被多图文对话框的样式覆盖。
// 真实 React UI + 内存 RPC；不是 Electron IPC，不访问微信，不加载编辑器。
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild'), { chromium } = require('playwright');
const repo = path.resolve(__dirname, '../..'), ui = path.join(repo, 'desktop/ui');
const parent = path.join(repo, '.test-tmp/layout-browser'); fs.mkdirSync(parent, { recursive: true });
const folder = fs.mkdtempSync(path.join(parent, 'run-'));
const report = { scope: 'Real UI / offline memory RPC; no Electron, editor, WeChat API or personal data', checks: {}, errors: [] };
let server, browser, page;
async function run() {
  esbuild.buildSync({ stdin: { contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';
    import{accountStore,queryClient}from'./data/client';import{Toaster}from'./components/toast';
    import{ArticleHome}from'./features/documents/ArticleHome';
    import{DocumentSidePanel}from'./features/documents/DocumentSidePanel';
    import{DEFAULT_STYLE}from'./features/documents/documentsApi';
    import './styles/documents.css';
    queryClient.setDefaultOptions({queries:{retry:false}});accountStore.set('layout-fixture');
    const iso=h=>new Date(Date.now()-h*3600e3).toISOString();
    const long='这是一个特别长的标题用来检查省略与换行'.repeat(4);
    const doc=i=>({id:'d'+i,document_id:'d'+i,kind:'document',title:i===0?long:'文章 '+i,origin:'blank',origin_ref:'',series:null,episode:null,lifecycle:'active',
      generation_state:'idle',updated_at:iso(i+1),created_at:iso(i+2),trashed_at:null,summary:long,word_count:1200,images:2,published:i===1,drafted:i===2,source_label:'空白',planned_date:null});
    window.calls=[];
    window.ice={request:async(method,p)=>{
      window.calls.push(method);
      if(method==='documents.list')return {documents:p.lifecycle==='trashed'?[]:[0,1,2,3].map(doc),legacy:[],account_id:'layout-fixture'};
      if(method==='documents.render_delivery')return {document_id:'d0',version_id:'v1',version_created_at:iso(1),title:long,content_hash:'h',delivery_hash:'dh',text:'x',
        html:'<p>'+long+'</p>',images:[],issues:[{severity:'warning',kind:'alt',message:long,block_id:''}],complete:true,style:DEFAULT_STYLE,info:{author:'作者',summary:long},cover:null};
      if(method==='publications.list')return [];
      if(method==='wechat.status')return {configured:true,appid:'wx1234567890abcdef',secret_set:true,last_check_at:null,last_check_ok:null,last_check_message:'',
        draft:{media_id:'MEDIA-abcdef-123456',version_id:'v0',synced_at:iso(3)},unknown_operation:null,
        groups:[{group_key:'g1',media_id:'MG-1',synced_at:iso(2),position:1,document_ids:['d0','d1'],current:false,members:[{document_id:'d0',title:long,available:true},{document_id:'d1',title:long,available:false}]}]};
      return {};
    }};
    const detail={document_id:'d0',title:long,meta:{},deliveries:[],series:null,publications:[],imports:[]};
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}>
      <div id="home"><ArticleHome/></div>
      <div id="side" className="ice-doc-side" style={{position:'static',display:'flex',height:600}}><DocumentSidePanel panel="delivery" onPanel={()=>{}} documentId="d0" style={DEFAULT_STYLE} onStyle={()=>{}}
        revision={()=>1} flush={async()=>{}} commitVersion={async()=>({version_id:'v2',created:true})} unversioned={false} onRestored={()=>{}} detail={detail} assist={{}}/></div>
      <div id="prose" className="ice-doc-layout" style={{'--doc-gap':'16px',display:'block'}}><div className="ice-doc-prose"><div className="ice-doc-group"><div className="ice-doc-group__grid"/></div><p>下一段</p></div></div>
      <Toaster/></QueryClientProvider>);
  `, resolveDir: path.join(ui, 'src'), loader: 'tsx' }, bundle: true, outfile: path.join(folder, 'app.js'), jsx: 'automatic', logLevel: 'silent' });
  server = http.createServer((req, res) => {
    if (req.url === '/app.js' || req.url === '/app.css') { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(folder, req.url.slice(1)))); }
    else { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ executablePath: process.env.ICE_TEST_CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => report.errors.push(e.message));
  const open = async () => { await page.goto('http://127.0.0.1:' + server.address().port); await page.locator('#home').getByText('文章 1').waitFor(); };
  await open(); await page.evaluate(() => localStorage.clear()); await open();
  const home = page.locator('#home');

  // 首页：测试与试用工具默认收起；展开后三个工具可用，状态记在本机
  const tools = home.locator('details.ice-doc-tools');
  assert.equal(await tools.evaluate(el => el.open), false);
  assert.equal(await home.getByRole('button', { name: /微信兼容测试稿/ }).isVisible(), false);
  assert.equal(await home.getByRole('button', { name: /空白文章/ }).isVisible(), true);
  await tools.locator('summary').click();
  for (const name of [/微信兼容测试稿/, /性能样本/, /作者试用记录/]) assert.equal(await home.getByRole('button', { name }).isVisible(), true);
  await page.waitForFunction(() => localStorage.getItem('ice.doc.home.tools') === '1');  // toggle 事件是异步派发的
  await open();
  assert.equal(await tools.evaluate(el => el.open), true);
  await tools.locator('summary').click();
  await page.waitForFunction(() => localStorage.getItem('ice.doc.home.tools') === '0');
  report.checks.home_tools_collapsed = true;

  // 首页：已同步草稿箱 / 已登记发布 的标记互不重复
  await home.getByText('已同步草稿箱').waitFor();
  assert.equal(await home.getByText('已同步草稿箱').count(), 1);
  assert.equal(await home.getByText('已登记发布').count(), 1);
  report.checks.home_draft_chip = true;

  // 交付侧栏（380px）：手机预览等固定宽度内容不把整列撑宽
  const side = page.locator('#side');
  await side.getByText('公众号草稿箱').waitFor();
  await side.getByText('多图文 · 第 1 篇 / 共 2 篇').waitFor();
  const body = side.locator('.ice-doc-side__body');
  assert.equal(await body.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
  assert.equal(await side.getByRole('button', { name: '同步到草稿箱' }).evaluate((el, limit) => el.getBoundingClientRect().right <= limit + 1,
    await side.evaluate(el => el.getBoundingClientRect().right)), true);
  report.checks.side_no_overflow = true;

  // 正文“多图并排”节点保留自己的段距（不被多图文对话框的列表样式覆盖）
  const group = await page.locator('#prose .ice-doc-group').evaluate(el => { const s = getComputedStyle(el); return { display: s.display, bottom: s.marginBottom }; });
  assert.deepEqual(group, { display: 'block', bottom: '16px' });
  report.checks.image_group_style = true;

  // 窄窗口：起步卡片两列，页面不横向溢出，文章列表在一屏内出现
  await page.setViewportSize({ width: 560, height: 800 });
  const cards = await home.locator('.ice-doc-starts:not(.ice-doc-starts--tools) .ice-doc-start').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)));
  assert.equal(new Set(cards).size, 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.ok(await home.locator('.ice-doc-list').evaluate(el => el.getBoundingClientRect().top) < 800);
  report.checks.narrow_home = true;
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
