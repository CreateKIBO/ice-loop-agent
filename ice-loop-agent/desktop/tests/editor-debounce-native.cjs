'use strict';
// 批次C1（2026-10-21 后续工程）：编辑器 800ms debounce 窗口内的导航必须先落盘工作草稿。
// 三条旅程各自重新 seed（新隔离数据）：切换会话 / 新建会话 / 切换公众号。
// 证据要求：打字后到导航触发之间 editor_draft_save 的 started 计数保持不变（证明确实
// 处于 debounce 窗口内而非已自动保存），激活时刻与打字时刻的单调时间差 <800ms，
// 随后通过真实 RPC articles.editor_draft_get 读回草稿并包含最新输入。
// 全程真实引擎检查点（seed 走 engine.create_job），不 raw SQL 建文章。
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');
const fixturePath=path.join(out,'interaction-lists-fixture.json');
const venv=path.join(repo,'.venv/Scripts/python.exe');
if(!fs.existsSync(fixturePath))throw Error('Run tests/seed_interaction_lists_native.py first');
const initial=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
if(path.dirname(initial.root)!==path.join(repo,'.test-tmp/release-interaction-lists')||!fs.existsSync(path.join(initial.root,'.test-owner.json')))throw Error('Owned fixture required');
const report={runtime:initial.runtime,state:'running',scope:'source Electron; real engine drafts; per-journey reseed',checks:{},journeys:{}};
const save=()=>fs.writeFileSync(path.join(out,'editor-debounce-native.json'),JSON.stringify(report,null,2));
const rows=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const started=(trace,method)=>rows(trace).filter(r=>r.method===method&&r.phase==='started').length;
const waitFor=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await wait(100);}throw Error('Evidence timeout');};

const journeys={
  switch_conversation:{
    activate:`document.querySelector('.ice-nav-row__main[title="键盘验收会话2"]').click()`,
    done:`Boolean(document.querySelector('[data-chat-pane]'))&&!document.querySelector('.ice-editor')`,
    doneNote:'会话2 面板可见且编辑器卸载',
  },
  new_conversation:{
    activate:null, // Ctrl+N 走真实 CDP 键盘（key('n',2)）
    done:`!document.querySelector('.ice-editor')&&document.querySelector('[data-chat-pane]')!==null`,
    doneNote:'新会话创建并进入，编辑器卸载',
  },
  switch_account:{
    activate:`document.querySelector('#ice-account-select').focus()`,
    extraKeys:['ArrowDown'],
  },
};
(async()=>{
 try{
  for(const [name,j] of Object.entries(journeys)){
    // 每旅程重新播种：全新隔离 runtime/entry/trace（fixture 指针被本轮旅程独占改写）。
    if(name!=='switch_conversation')execFileSync(venv,['-X','utf8','-B',path.join(repo,'tests','seed_interaction_lists_native.py')],{cwd:repo,windowsHide:true,stdio:'ignore'});
    const f=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
    const evidence=path.join(initial.root,'journey-evidence',name);fs.mkdirSync(evidence,{recursive:true});
    fs.copyFileSync(fixturePath,path.join(evidence,'fixture.json'));
    const session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});
    try{
      const {evaluate:evaluate0,call:call0,until}=session;
      const call=async(m,p)=>{try{return await call0(m,p);}catch(e){throw Error(m+' -> '+String((e&&e.message)||e).slice(0,160));}};
      const evaluate=async x=>{try{return await evaluate0(x);}catch(e){throw Error('evaluate('+x.slice(0,80)+') -> '+String((e&&e.message)||e).slice(0,160));}};
      report.progress=name+':session-open';save();
      const VK={Enter:13,Escape:27,ArrowDown:40,n:78};
      const key=async(keyName,modifiers=0)=>{const code=VK[keyName]??keyName.toUpperCase().charCodeAt(0);
        await call('Input.dispatchKeyEvent',{type:'keyDown',key:keyName,modifiers,windowsVirtualKeyCode:code,...(keyName==='Enter'?{text:'\r'}:{})});
        await call('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,modifiers,windowsVirtualKeyCode:code});};
      await until(`document.querySelectorAll('.ice-nav-row .ice-nav-row__main').length>=4`);
      report.progress=name+':nav-ready';save();
      // 真实入口打开编辑器（任务卡「编辑正文」按钮，焦点+Enter 单次激活）。
      const openEditor = `[...document.querySelectorAll('li[data-job-id="job-kb-done"] button')].find(b=>b.innerText.trim()==='编辑正文')`;
      await until(`Boolean(${openEditor})&&!${openEditor}.disabled`);
      await evaluate(`${openEditor}.focus()`);
      await until(`document.activeElement===${openEditor}`);
      await key('Enter');
      await until(`Boolean(document.querySelector('.ice-editor[contenteditable="true"]'))`);
      report.progress=name+':editor-open';save();
      const marker='窗口内落盘'+name+'标记'+Date.now().toString(36);
      const baseline=started(f.trace,'articles.editor_draft_save');
      // 在编辑器末尾真实键入（CDP insertText，走 onUpdate → scheduleDraft 800ms debounce）。
      await evaluate(`(()=>{const e=document.querySelector('.ice-editor');e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
      const t0=await evaluate(`performance.now()`);
      await call('Input.insertText',{text:marker});
      report.progress=name+':typed';save();
      // 激活前即时读盘：此刻 debounce 未触发（800ms 未到）——证明处于窗口内。
      const savesAtClick=started(f.trace,'articles.editor_draft_save');
      // 导航触发：窗口内单次激活（各旅程真实入口；单调时间记录激活时刻）。
      let activation;
      if(name==='new_conversation'){
        await key('n',2); // 真实 CDP Ctrl+N → useGlobalShortcuts → createConversation
        activation=await evaluate(`performance.now()`);
        await until(`!document.querySelector('.ice-editor')&&document.querySelector('[data-chat-pane]')!==null`);
      }else if(name==='switch_account'){
        await evaluate(j.activate);
        await key('ArrowDown'); // 真实键盘：下拉真实选择 B 并触发 change
        activation=await evaluate(`performance.now()`);
        await until(`document.querySelector('#ice-account-select')?.value===${JSON.stringify(f.account_b)}`);
        await until(`[...document.querySelectorAll('.ice-nav-row__main')].some(b=>b.title==='B号独占会话')`);
      }else{
        activation=await evaluate(`( ()=>{const t=performance.now();${j.activate};return t;} )()`);
        await until(j.done);
      }
      const elapsed=activation-t0;
      const savesBeforeActivation=savesAtClick;
      // 落盘回读：真实 RPC 读 A 号域的工作草稿。
      await waitFor(()=>started(f.trace,'articles.editor_draft_save')>baseline);
      let draftHasMarker,draftTail='';
      if(name==='switch_account'){
        // 页面已切到 B：后端按账号域正确拒绝 A 的读取（真实守卫）。改用真实
        // DesktopService 子进程切回 A 后走同一 RPC 读——不是 raw SQL。
        const probe=execFileSync(venv,['-X','utf8','-B','-c',
          "import json,sys\n"+
          "sys.path.insert(0,sys.argv[1])\n"+
          "from ice_agent.desktop_service import DesktopService\n"+
          "repo,runtime,articles,account,job,marker=sys.argv[1:7]\n"+
          "svc=DesktopService(repo,runtime,articles,auto_consumer=False)\n"+
          "try:\n"+
          "    svc.call('accounts.switch',{'account_id':account})\n"+
          "    d=svc.call('articles.editor_draft_get',{'job_id':job})\n"+
          "    content=(d.get('draft') or {}).get('content','')\n"+
          "    print(json.dumps({'has':marker in content,'tail':content[-40:]}))\n"+
          "finally:\n"+
          "    svc.close()",
          repo,f.runtime,path.join(f.root,'articles'),f.account_a,'job-kb-done',marker],
          {cwd:repo,windowsHide:true,encoding:'utf8'});
        const parsed=JSON.parse(probe.trim().split('\n').at(-1));
        draftHasMarker=parsed.has;draftTail=parsed.tail;
      }else{
        const draft=JSON.parse(await evaluate(`window.ice.request('articles.editor_draft_get',${JSON.stringify({account_id:f.account_a,job_id:'job-kb-done'})}).then(r=>JSON.stringify(r))`));
        draftHasMarker=Boolean(draft.draft?.content?.includes(marker));
        draftTail=(draft.draft?.content||'').slice(-60);
      }
      const entry={runtime:f.runtime,fixtureSnapshot:path.join(evidence,'fixture.json'),elapsedMs:Math.round(elapsed),savesBeforeActivation,baseline,draftHasMarker,contentTail:draftTail};
      report.journeys[name]=entry;
      const check=(label,value)=>{report.checks[name+'_'+label]=Boolean(value);save();if(!value)throw Error(name+' '+label+' failed');};
      check('acted_inside_debounce_window',savesBeforeActivation===baseline&&elapsed<800);
      check('draft_persisted_latest_input',entry.draftHasMarker);
      if(name==='switch_conversation')check('editor_unmounted_after_switch',await evaluate(`!document.querySelector('.ice-editor')`));
      if(name==='new_conversation')check('create_wrote_once',rows(f.trace).filter(r=>r.method==='chat.create'&&r.phase==='resolved').length===1);
      if(name==='switch_account')check('account_switched_to_b',await evaluate(`document.querySelector('#ice-account-select')?.value`)===f.account_b);
    }finally{await session.close();}
  }
  report.state='finished';
 }catch(error){report.state='failed';report.error=error.stack;}
 finally{save();}
 console.log(JSON.stringify({state:report.state,checks:report.checks}));process.exitCode=report.state==='finished'?0:1;
})().catch(error=>{console.error(error);process.exitCode=1;});
