'use strict';
// 批A/B/C 纯推导（2026-10-22 用户制作流程）：建议下一步 / 查看偏好 / 大纲预检 / 配图清单。
const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),Module=require('node:module'),esbuild=require('esbuild');
const UI=path.resolve(__dirname,'../ui');
function compile(relative){
 const result=esbuild.buildSync({entryPoints:[path.join(UI,'src',relative)],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*'],logLevel:'silent'});
 const m=new Module(path.join(UI,'.workflow-views-test.cjs'));m.filename=path.join(UI,'.workflow-views-test.cjs');m.paths=Module._nodeModulePaths(UI);m._compile(result.outputFiles[0].text,m.filename);return m.exports;
}
const guide=compile('features/tasks/jobGuide.ts');
const prefs=compile('features/tasks/jobViewPrefs.ts');
const editorial=compile('features/editorial/editorialModel.ts');
const model=compile('features/assets/assetModel.ts');

const job=state=>({state,current_node:'outline',series:'PY',episode:11,topic:'示例选题',final_title:null});

test('jobGuide maps every real state to existing entries with deterministic priority',()=>{
  assert.equal(guide.jobGuide(job('awaiting_approval')).actions[0].label,'审阅此步');
  assert.equal(guide.jobGuide({...job('awaiting_user'),current_node:'verify_code'}).actions[0].label,'审阅代码与输入');
  assert.equal(guide.jobGuide(job('failed')).actions[0].label,'查看中断原因');
  assert.equal(guide.jobGuide(job('failed')).blocking,null);
  assert.equal(guide.jobGuide({...job('failed'),pause_reason:'模型返回为空'}).blocking,'模型返回为空');
  assert.equal(guide.jobGuide(job('paused')).actions[0].key,'resume');
  assert.equal(guide.jobGuide(job('completed')).actions[0].key,'editor');
  assert.ok(guide.jobGuide(job('running')).actions[0].label.includes('查看处理进度'));
  assert.equal(guide.jobGuide({...job('weird_state_x')}).actions[0].label,'查看详情');
  assert.ok(guide.jobGuide({...job('weird_state_x')}).actions[0].hint.includes('weird_state_x'));
  assert.equal(guide.jobGuide({...job('running'),stopping:1}).summary.includes('正在停止'),true);
  assert.deepEqual([ 'awaiting_approval','failed','paused' ].map(state=>guide.needsUserAction(job(state))),[true,true,true]);
  assert.equal(guide.needsUserAction(job('running')),false);
  assert.equal(guide.needsUserAction({...job('paused'),stopping:1}),false);
});

test('job filter and search cover title, series, episode and the stable mine view',()=>{
  const mine=[job('awaiting_approval'),job('failed'),job('paused')],others=[job('running'),job('completed')];
  assert.equal(mine.every(row=>guide.jobMatchesFilter(row,'mine','')),true);
  assert.equal(others.every(row=>guide.jobMatchesFilter(row,'mine','')),false);
  assert.equal(guide.jobMatchesFilter(job('paused'),'paused',''),true);
  assert.equal(guide.jobMatchesFilter(job('paused'),'completed',''),false);
  const titled={...job('completed'),final_title:'列表循环入门',series:'JV',episode:103};
  assert.equal(guide.jobMatchesFilter(titled,'all','循环'),true);
  assert.equal(guide.jobMatchesFilter(titled,'all','jv'),true);
  assert.equal(guide.jobMatchesFilter(titled,'all','103'),true);
  assert.equal(guide.jobMatchesFilter(titled,'all','JV-103'),true);
  assert.equal(guide.jobMatchesFilter(titled,'all','PY'),false);
  assert.equal(guide.jobMatchesFilter(titled,'all','  '),true);
});

test('job view prefs persist per account, reject corruption and oversized payloads',()=>{
  const store=new Map();
  const storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accA'),{statusFilter:'all',compact:false});
  assert.equal(prefs.saveJobViewPrefs(storage,'accA',{statusFilter:'mine',compact:true}),true);
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accA'),{statusFilter:'mine',compact:true});
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accB'),{statusFilter:'all',compact:false}); // 账号范围隔离
  store.set('ice.ui.jobview.v1.accA','{ not json');
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accA'),{statusFilter:'all',compact:false});
  store.set('ice.ui.jobview.v1.accA',JSON.stringify({statusFilter:'drop-table',compact:'yes'}));
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accA'),{statusFilter:'all',compact:false}); // 非白名单回退
  store.set('ice.ui.jobview.v1.accA','x'.repeat(300));
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accA'),{statusFilter:'all',compact:false}); // 超长损坏值读取回退默认
  // 守卫限制的是“将写入的 payload”长度：合法保存会覆盖垃圾值，而不是被旧值阻塞。
  assert.equal(prefs.saveJobViewPrefs(storage,'accA',{statusFilter:'mine',compact:false}),true);
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'accA'),{statusFilter:'mine',compact:false});
  assert.ok(store.get('ice.ui.jobview.v1.accA').length<=256);
  prefs.clearJobViewPrefs(storage,'accA');
  assert.equal(store.has('ice.ui.jobview.v1.accA'),false);
  assert.equal([...store.keys()].length,0); // 只清除自己的键
});

test('outline preview summary counts real ranges and conflicts only from parsed rows',()=>{
  const rows=[
    {series:'JV',episode:101,title:'跨页重复检测A',include:true,existing:{title:'旧A'}},
    {series:'JV',episode:102,title:'跨页重复检测B',include:true},
    {series:'PY',episode:7,title:'',include:true},
    {series:'PY',episode:7,title:'同栏目同期号',include:true},
    {series:'PY',episode:8,title:'被取消的行',include:false},
  ];
  const summary=editorial.previewSummary(rows);
  assert.equal(summary.count,5);assert.equal(summary.included,4);
  assert.deepEqual(summary.seriesList,['JV','PY']);
  assert.equal(summary.episodeMin,7);assert.equal(summary.episodeMax,102);
  assert.equal(summary.conflicts,1);assert.ok(summary.issues>=3);
  assert.deepEqual(editorial.previewRowIssues(rows[0],rows),[]); // 覆盖行本身没有前端问题
  const issues2=editorial.previewRowIssues(rows[1],rows);
  assert.equal(issues2.length,0);
  const issues3=editorial.previewRowIssues(rows[2],rows);
  assert.ok(issues3.some(text=>text.includes('标题为空')));
  assert.ok(issues3.some(text=>text.includes('重复')));
  assert.ok(editorial.previewRowIssues(rows[4],rows).length===0); // 已取消保留的行不计
  assert.ok(editorial.previewRowIssues({series:'',episode:0,title:'x'.repeat(31),include:true},rows)
    .some(text=>text.includes('缺少栏目')));
  const rowBad=editorial.previewRowIssues({series:'PY',episode:0,title:'x'.repeat(31),include:true},[]);
  assert.ok(rowBad.some(text=>text.includes('期号'))&&rowBad.some(text=>text.includes('超过30字')));
});

test('analyzePreview computes row issues, covering and additions in one pass',()=>{
  const rows=[
    {series:'JV',episode:101,title:'跨页重复检测A',include:true,existing:{title:'旧A'}},
    {series:'JV',episode:101,title:'跨页重复检测B',include:true},
    {series:'PY',episode:7,title:'',include:true},
    {series:'PY',episode:7,title:'同栏目同期号',include:true},
    {series:'PY',episode:8,title:'被取消的行',include:false},
  ];
  const analysis=editorial.analyzePreview(rows);
  assert.deepEqual(analysis.issues[0],['与预览第 2 条重复（同栏目同期号）']); // 覆盖行也会因预览内重复被标记
  assert.ok(analysis.issues[1][0].includes('与预览第 1 条重复')); // 重复互相指向另一条
  assert.ok(analysis.issues[3].some(t=>t.includes('与预览第 3 条重复'))); // 首次出现者同样被标记并指向后续行
  assert.ok(analysis.issues[2].some(t=>t.includes('标题为空')));
  assert.ok(analysis.issues[4].length===0);           // 已取消保留不计
  assert.equal(analysis.covering.length,1);
  assert.equal(analysis.covering[0].index,0);
  assert.equal(analysis.additions,3);                 // 保留 4 条中 1 条覆盖
  assert.equal(analysis.summary.conflicts,1);
  assert.equal(analysis.summary.issues,analysis.issues.flat().length);
  // 与逐行独立入口一致（单行核对路径的等价性）
  assert.deepEqual(analysis.issues[1],editorial.previewRowIssues(rows[1],rows));
});

test('asset checklist uses saved data, marks unread references and never fakes prompts',()=>{
  const data={article:{final_title:'列表循环',topic:'t',series:'JV',episode:23},
    job:{job_id:'job-x'},cover_prompt:'封面提示词ABC',
    slots:[
      {slot_id:'s1',figure_no:1,kind:'cover',caption:'封面',position:'首页头图',valid:true,prompt:'',candidates:[],content_hash:'h1'},
      {slot_id:'s2',figure_no:2,kind:'body_ai',caption:'循环示意',valid:false,prompt:'逐项追加提示词',candidates:[],content_hash:'h2'},
      {slot_id:'s3',figure_no:3,kind:'body_real',caption:'运行结果',position:'正文第三节',valid:false,prompt:'',candidates:[],content_hash:'h3'},
    ]};
  const overviews=model.slotOverviews(data);
  assert.deepEqual(overviews.map(row=>[row.figureNo,row.hasPrompt,row.valid]),[[1,true,true],[2,true,false],[3,false,false]]);
  assert.equal(overviews[2].kindText,'真实截图');
  const list=model.buildAssetChecklist(data,figureNo=>figureNo===2?[{image:1,role:'style',filename:'style.png',title:'风格'}]:null);
  assert.ok(list.includes('配图制作清单 · 列表循环（JV-023）'));
  assert.ok(list.includes('图1 · 封面 · 封面（位置：首页头图）'));
  assert.ok(list.includes('已有有效图片（已采纳）'));
  assert.ok(list.includes('封面提示词ABC')); // cover 无 slot.prompt 时回退 cover_prompt（已保存）
  assert.ok(list.includes('图3 · 真实截图 · 运行结果'));
  assert.ok(list.includes('真实截图图位，不需要生图提示词'));
  assert.ok(list.includes('本次未读取该图位的参考列表')); // 图1 参考未读 → 明确标注
  assert.ok(list.includes('风格参考 · style.png'));       // 图2 实际读到的参考
  assert.ok(list.includes('待配图'));
  assert.equal(list.includes('提示词：尚未准备'),false); // 所有需要生图的图位都已保存提示词
  const noPrompt={...data,cover_prompt:'',slots:[{slot_id:'s0',figure_no:1,kind:'cover',caption:'封面',valid:false,prompt:'',candidates:[],content_hash:'h'}]};
  assert.ok(model.buildAssetChecklist(noPrompt,()=>null).includes('提示词：尚未准备'));
});


test('queued work remains in the in-progress filter and read-only advice never resumes a job',()=>{
  assert.equal(guide.jobMatchesFilter(job('queued'),'running',''),true);
  for(const state of ['awaiting_approval','awaiting_user']){
    assert.equal(guide.jobGuide(job(state)).actions.every(action=>action.key==='review'),true);
  }
  assert.equal(guide.jobGuide({...job('mystery'),current_node:'toString'}).summary.includes('当前步骤 toString'),true);
});

test('valid JSON above the preference read limit is rejected before parsing preferences',()=>{
  const raw=JSON.stringify({statusFilter:'mine',compact:true,padding:'x'.repeat(300)});
  assert.deepEqual(prefs.loadJobViewPrefs({getItem:()=>raw},'A'),{statusFilter:'all',compact:false});
});


test('next-step diagnostics redact credentials before truncating the summary',()=>{
  const reason='Authorization: Bearer sk-credential-test-123456789 '+ 'x'.repeat(200);
  const result=guide.jobGuide({...job('failed'),pause_reason:reason});
  assert.equal(result.blocking.includes('credential-test'),false);
  assert.ok(result.blocking.length<=61);
});


test('reset preferences only affects selected account and reports unavailable storage',()=>{
  const rows=new Map([['ice.ui.jobview.v1.A','{"statusFilter":"mine","compact":true}'],['ice.ui.jobview.v1.B','{"statusFilter":"paused","compact":true}'],['unrelated','preserve']]);
  const storage={getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};
  assert.equal(prefs.resetJobViewPrefs(storage,'A'),true);
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'A'),prefs.DEFAULT_JOB_VIEW);
  assert.deepEqual(prefs.loadJobViewPrefs(storage,'B'),{statusFilter:'paused',compact:true});
  assert.equal(rows.get('unrelated'),'preserve');
  assert.equal(prefs.resetJobViewPrefs({removeItem(){throw Error('denied');},setItem(){throw Error('denied');}},'A'),false);
});
