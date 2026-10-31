'use strict';
// Production page, real offline reads. Startup repairs an orphaned stream, so
// this audits that boundary instead of fabricating a live consumer or model.
module.exports=async function readingWait({e,call,ui,click,check,until,wait,rpc,requests,fixture,report}){
  const current=await rpc('chat.get',{account_id:fixture.account_a,conversation_id:fixture.conversations[0]});
  const row=current.messages.find(r=>r.id==='reading-wait-stream');
  report.waiting={liveWaitDriven:false,requestedStatus:'streaming',observed:row};
  check('orphaned_empty_stream_is_recovered_as_interrupted',row?.status==='interrupted'&&row.content==='');
  if(row?.status!=='interrupted')throw Error('Owned orphan fixture did not meet startup recovery boundary');
  const frames=()=>e('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await e(`document.documentElement.dataset.reduceMotion='true'`);await frames();
  await click(`document.querySelector('button[title="键盘验收会话1"]')`);
  const message=`document.querySelector('[data-message-id="reading-wait-stream"]')`;
  await ui(`Boolean(${message})&&(${message}).textContent.includes('应用关闭时中断')`);
  const retry=`[...(${message}).querySelectorAll('button')].find(b=>b.textContent.trim()==='重试此回复')`;
  check('interrupted_feedback_explains_status_without_stale_waiting',await e(`(${message}).textContent.includes('内容可能不完整')&&!document.querySelector('.ice-turn-progress')`));
  check('retry_requires_explicit_enabled_user_action',await e(`Boolean(${retry})&&!(${retry}).disabled&&(${message}).textContent.includes('这会重新调用模型')`));
  await e(`void(window.waitNode=${message});void(window.waitRetry=${retry})`);
  const count=()=>requests.filter(r=>r.method==='chat.get'&&r.source==='renderer'&&r.finished&&!r.failed).length,before=count();
  await until(()=>Promise.resolve(count()>before),'real recovered idle read poll',12000);
  check('poll_retains_interruption_node_and_retry_control',await e(`window.waitNode===${message}&&window.waitRetry===(${retry})&&!document.querySelector('.ice-turn-progress')`));
  await call('Emulation.setDeviceMetricsOverride',{width:500,height:600,deviceScaleFactor:1,mobile:false});await wait(250);
  await e(`(${retry}).scrollIntoView({block:'center'});(${retry}).focus({preventScroll:true})`);await frames();
  check('narrow_chat_has_no_horizontal_overflow',await e(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.ice-chat-log').scrollWidth<=document.querySelector('.ice-chat-log').clientWidth+1`));
  check('narrow_retry_can_be_focused_and_revealed',await e(`(()=>{const n=${retry},r=n.getBoundingClientRect();return n===document.activeElement&&r.top>=0&&r.bottom<=innerHeight;})()`));
  check('waiting_scope_has_no_model_or_write_dispatch',!requests.some(r=>/^(chat.send|chat.stop|articles.save|prompts.generate|jobs.resume)$/.test(r.method)));
};
