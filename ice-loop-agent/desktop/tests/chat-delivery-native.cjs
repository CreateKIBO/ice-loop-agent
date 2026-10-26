"use strict";
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备');const f=JSON.parse(fs.readFileSync(path.join(out,'chat-delivery-fixture.json')));
assert.equal(path.dirname(f.root),path.join(repo,'.test-tmp/release-chat-delivery'));
const report={state:'running',runtime:f.runtime,checks:{},errors:[],scope:'real source Electron and backend; offline Mock model; deliberate IPC loss/delay'};
const save=()=>fs.writeFileSync(path.join(out,'chat-delivery-native.json'),JSON.stringify(report,null,2));const check=(name,value)=>{report.checks[name]=Boolean(value);save();assert(value,name);};
const fault=value=>fs.writeFileSync(f.fault,JSON.stringify(value));
const trace=()=>fs.existsSync(f.trace)?fs.readFileSync(f.trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
let session;
(async()=>{try{
 save();session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});const {evaluate:e,until,call}=session;
 const rpc=(method,params={})=>e(`window.ice.request(${JSON.stringify(method)},${JSON.stringify({account_id:f.account_a,...params})})`);
 const button=text=>`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)}&&!b.disabled)`;
 const click=async text=>{await until(`Boolean(${button(text)})`);await e(`(${button(text)}).click()`);};
 const open=async(key)=>{const data=await rpc('chat.get',{conversation_id:f.cases[key]});await until(`Boolean(document.querySelector('button[title=${JSON.stringify(data.conversation.title)}]'))`);await e(`document.querySelector('button[title=${JSON.stringify(data.conversation.title)}]').click()`);await until(`Boolean(document.querySelector('[data-chat-pane]'))&&document.querySelector('[data-chat-pane]').innerText.includes(${JSON.stringify(data.conversation.title)})`);await until(`Boolean(document.querySelector('textarea[aria-label="消息输入"]'))`);};
 const input=async text=>{await e(`document.querySelector('textarea[aria-label="消息输入"]').focus()`);await call('Input.insertText',{text});};
 const settled=cid=>e(`window.ice.request('chat.get',{account_id:${JSON.stringify(f.account_a)},conversation_id:${JSON.stringify(cid)}}).then(r=>!r.messages.some(m=>m.status==='streaming'))`);
 const waitTurn=async cid=>{for(let i=0;i<120;i++){if(await settled(cid))return;await wait(100);}throw Error('Turn did not finish');};
 await until(`Boolean(document.querySelector('#ice-account-select'))`);
 await open('rapid');await input('只发送一次的讨论');
 await e(`document.querySelector('textarea[aria-label="消息输入"]').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`);
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',windowsVirtualKeyCode:13,text:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',windowsVirtualKeyCode:13});
 await e(`document.querySelector('textarea[aria-label="消息输入"]').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
 check('ime-confirmation-does-not-send-a-turn',(await rpc('chat.get',{conversation_id:f.cases.rapid})).messages.length===0);

 await e(`(()=>{const b=${button('发送')};b.click();b.click();b.click();})()`);await waitTurn(f.cases.rapid);await until(`document.querySelector('textarea[aria-label="消息输入"]').value===''`);
 const rapid=await rpc('chat.get',{conversation_id:f.cases.rapid});check('same-tick-three-clicks-produce-one-user-and-one-reply',rapid.messages.length===2);
 // Once the accepted row was observed, later window movement must not revive
 // its temporary streaming fallback. Advance only this owned fixture's history.
 await until(`document.querySelector('.ice-conversation-header__status')?.innerText==='已就绪'`);
 execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',
  "import sqlite3,sys;from pathlib import Path;r=Path(sys.argv[1]);assert r.parent.parent.name=='release-chat-delivery';d=sqlite3.connect(r/'app.db');d.executemany('INSERT INTO creative_messages VALUES (?,?,?,?,?,?,?)',[(f'window-advance-{i}',sys.argv[2],'assistant',f'外部导入的历史消息 {i}','completed','{}','2026-10-25T00:00:00Z') for i in range(45)]);d.commit();d.close()",f.runtime,f.cases.rapid],{cwd:repo,env:session.env,windowsHide:true});
 await click('重命名');await until(`Boolean(document.querySelector('#ice-conversation-title'))`);
 await e(`(()=>{const n=document.querySelector('#ice-conversation-title');n.focus();n.select();})()`);await call('Input.insertText',{text:'发送连点验收·窗口推进'});await click('保存名称');
 await until(`Boolean(document.querySelector('[data-message-id="window-advance-44"]'))`);
 await input('窗口推进后仍可继续编辑');
 check('observed-acceptance-does-not-stick-after-message-window-advances',await e(`document.querySelector('.ice-conversation-header__status')?.innerText==='已就绪'&&Boolean(${button('发送')})`));
 // Lose the delivery receipt after the real handler accepted it; preserve edits.
 await open('lost');fault({loseAfterReply:['chat.send']});await input('需要核对的原请求');await click('发送');await until(`document.querySelector('[aria-label="发送状态"]')?.innerText.includes('结果尚未确认')`);
 await input('，这是发送后的新输入');const edited=await e(`document.querySelector('textarea[aria-label="消息输入"]').value`);fault({});await click('核对并继续发送');await waitTurn(f.cases.lost);await until(`!document.querySelector('[aria-label="发送状态"]')?.innerText.includes('结果尚未确认')`);
 check('lost-receipt-replay-does-not-create-another-turn',(await rpc('chat.get',{conversation_id:f.cases.lost})).messages.length===2);
 check('replay-keeps-changes-made-after-original-send',await e(`document.querySelector('textarea[aria-label="消息输入"]').value===${JSON.stringify(edited)}`));
 // A reload may only look up the pending receipt; never generate automatically.
 await open('reload');fault({loseAfterReply:['chat.send']});await input('重启后只核对');await click('发送');await until(`document.querySelector('[aria-label="发送状态"]')?.innerText.includes('结果尚未确认')`);fault({});const sendsBefore=trace().filter(row=>row.method==='chat.send'&&row.phase==='started').length;
 await call('Page.reload');await until(`Boolean(document.querySelector('#ice-account-select'))`);await open('reload');await until(`document.querySelector('textarea[aria-label="消息输入"]').value===''`);
 check('reload-uses-readonly-receipt-lookup',trace().filter(row=>row.method==='chat.send'&&row.phase==='started').length===sendsBefore);
 check('reloaded-request-remains-one-turn',(await rpc('chat.get',{conversation_id:f.cases.reload})).messages.length===2);
 // Cancel while the invoke is deliberately delayed before the real Python call.
 await open('cancel');fault({delayMs:{'chat.send':1800}});await input('排队中的A请求');const before=trace().length;await click('发送');await until(`Boolean(${button('取消这次请求')})`);await click('取消这次请求');await until(`document.querySelector('[aria-label="发送状态"]')?.innerText.includes('已取消')`);fault({});
 await e(`(()=>{const n=document.querySelector('textarea[aria-label="消息输入"]');n.focus();n.select();})()`);await call('Input.insertText',{text:'新的B请求'});await click('发送');await wait(2300);await waitTurn(f.cases.cancel);
 const cancel=await rpc('chat.get',{conversation_id:f.cases.cancel});check('cancelled-delayed-request-never-reaches-model',cancel.messages.length===2&&cancel.messages[0].content==='新的B请求');
 check('late-cancelled-response-cannot-restore-old-pending-banner',!await e(`document.querySelector('[aria-label="发送状态"]')?.innerText.includes('结果尚未确认')`));
 check('delayed-original-really-was-in-flight',trace().slice(before).some(row=>row.method==='chat.send'&&row.elapsed_ms>=1700));
 // A late acknowledgement is scoped to A even after B becomes active.
 await open('switch');const switchStart=trace().length;fault({responseDelayMs:{'chat.send':1600}});await input('A号的专用要求');await click('发送');
 for(let i=0;i<60&&!trace().slice(switchStart).some(row=>row.method==='chat.send'&&row.phase==='handler_returned');i++)await wait(30);
 const switchAccount=async id=>{await e(`(()=>{const n=document.querySelector('#ice-account-select');n.value=${JSON.stringify(id)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`document.querySelector('#ice-account-select')?.value===${JSON.stringify(id)}`);};
 await switchAccount(f.account_b);await wait(1800);check('late-acknowledgement-does-not-leak-into-other-account',!await e(`document.body.innerText.includes('A号的专用要求')||Boolean(document.querySelector('[aria-label="发送状态"]'))`));
 fault({});await switchAccount(f.account_a);await open('switch');check('return-to-original-account-does-not-restore-acknowledged-input',await e(`document.querySelector('textarea[aria-label="消息输入"]').value===''`));
 // Exact backend errors cross the dedicated structured IPC boundary.
 await open('budget');await input('已满预算的请求');await click('发送');await until(`document.querySelector('[aria-label="发送状态"]')?.innerText.includes('本次请求未受理')`);
 check('known-rejection-keeps-input-without-uncertain-lock',await e(`document.querySelector('textarea[aria-label="消息输入"]').value==='已满预算的请求'&&Boolean(${button('发送')})`));
 check('budget-has-inline-settings-action',await e(`Boolean(${button('打开预算设置')})&&!document.querySelector('.ice-toast--danger')`));
 check('engine-budget-code-is-mapped-in-real-renderer',await e(`document.querySelector('[aria-label="发送状态"]').innerText.includes('模型调用已达上限')`));
 // Real failed reply -> retry -> immutable candidate -> saved draft in sidebar.
 await open('failed');check('failure-diagnostic-does-not-leak-secret',!await e(`document.body.innerText.includes('DO_NOT_SHOW_DELIVERY_SECRET')`));await click('重试此回复');await waitTurn(f.cases.failed);await until(`Boolean(${button('保存为草稿')})`);
 const retried=await rpc('chat.get',{conversation_id:f.cases.failed});check('retry-keeps-original-message-and-creates-one-new-candidate',retried.messages.length===4&&retried.candidates.length===1&&retried.messages[1].status==='failed');await click('保存为草稿');await until(`document.body.innerText.includes('已保存为草稿')`);
 check('retry-draft-reaches-real-shared-draft-library',(await rpc('chat.drafts')).some(row=>row.conversation_id===f.cases.failed));
 // Editable clarification options, local restoration and real answer submission.
 await open('question');await until(`Boolean(document.querySelector('[aria-label="补充创作信息"]'))`);
 check('clarification-needs-all-answers',await e(`[...document.querySelectorAll('button')].find(b=>b.innerText==='确认回答并继续生成').disabled`));await click('零基础读者');await click('倒计时');
 const answer='零基础读者，并保留可运行的练习';await e(`(()=>{const n=document.querySelector('textarea[aria-label="这篇文章面向哪类读者？的回答"]');n.focus();n.select();})()`);await call('Input.insertText',{text:answer});
 await open('rapid');await open('question');check('clarification-local-answer-restores-after-switch',await e(`document.querySelector('textarea[aria-label="这篇文章面向哪类读者？的回答"]').value===${JSON.stringify(answer)}`));
 await e(`(()=>{const n=document.querySelector('select[aria-label="本次知识引文"]');n.value='selected';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 check('empty-new-citation-selection-blocks-clarification-send',await e(`[...document.querySelectorAll('button')].find(b=>b.innerText==='确认回答并继续生成').disabled`));
 await e(`(()=>{const n=document.querySelector('select[aria-label="本次知识引文"]');n.value='inherit';n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 check('explicit-inheritance-keeps-complete-answers-submittable',await e(`![...document.querySelectorAll('button')].find(b=>b.innerText==='确认回答并继续生成').disabled`));
 for(const width of [500,800,1280]){await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});check('clarification-no-horizontal-overflow-'+width,await e(`document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.ice-clarification').scrollWidth<=document.querySelector('.ice-clarification').clientWidth+1`));}
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});const formShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(f.root,'clarification-form.png'),Buffer.from(formShot.data,'base64'));await click('确认回答并继续生成');await waitTurn(f.cases.question);await until(`Boolean(${button('保存为草稿')})`);
 const answered=await rpc('chat.get',{conversation_id:f.cases.question});check('answers-mark-original-question-and-create-draft',answered.messages[1].metadata.answers.reader===answer&&answered.messages[1].metadata.clarification_status==='answered'&&answered.candidates.length===1);
 const screenshot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(f.root,'clarification-finished.png'),Buffer.from(screenshot.data,'base64'));
 const counts=JSON.parse(execFileSync(path.join(repo,'.venv/Scripts/python.exe'),['-X','utf8','-B','-c',"import sqlite3,json,sys;from pathlib import Path;d=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);print(json.dumps(dict(d.execute('SELECT conversation_id,COUNT(*) FROM model_invocations GROUP BY conversation_id'))));d.close()",path.join(f.runtime,'app.db')],{cwd:repo,env:session.env,encoding:'utf8',windowsHide:true}));
 check('every-case-uses-only-its-single-authorized-offline-model-call',Object.values(f.cases).every(id=>counts[id]===1));
 check('no-uncaught-renderer-errors',session.errors.length===0);report.state='finished';report.success=true;
 }catch(error){report.state='failed';report.errors.push(error.stack);if(session)try{const shot=await session.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(f.root,'failure.png'),Buffer.from(shot.data,'base64'));}catch{}throw error;}
 finally{save();if(session)await session.close();}
})().then(()=>console.log(JSON.stringify({state:report.state,checks:Object.keys(report.checks).length,root:f.root}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
