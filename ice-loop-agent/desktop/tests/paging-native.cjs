'use strict';
const fs=require('node:fs'),path=require('node:path');
const {openNativeSession,wait}=require('./native-session.cjs');
const repo=path.resolve(__dirname,'../..'),out=path.join(repo,'docs/上线准备'),f=JSON.parse(fs.readFileSync(path.join(out,'paging-fixture.json'),'utf8'));
const attempt=path.join(out,'paging-attempts',path.basename(f.root)+'-'+Date.now());fs.mkdirSync(attempt,{recursive:true});
const report={state:'running',runtime:f.runtime,evidence_dir:attempt,ipc_observation_only:true,checks:{},errors:[]};
const save=()=>{const s=JSON.stringify(report,null,2);fs.writeFileSync(path.join(out,'paging-native.json'),s);fs.writeFileSync(path.join(attempt,'result.json'),s);};
const assert=(name,ok)=>{report.checks[name]=Boolean(ok);save();if(!ok)throw Error(name+' failed');};
const observed=()=>fs.existsSync(f.observations)?fs.readFileSync(f.observations,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
let session,call,evaluate,until;
const button=(text,scope='document')=>`[...${scope}.querySelectorAll('button')].find(e=>e.innerText.trim()===${JSON.stringify(text)}&&!e.matches(':disabled'))`;
const click=async(text,scope='document')=>{
 const selector=button(text,scope);
 await until(`(()=>{const e=${selector};if(!e)return false;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`);
 const point=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const e=${selector},r=e.getBoundingClientRect();resolve({x:r.x+r.width/2,y:r.y+r.height/2});})))`);
 await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
};
const field=async(label,value)=>evaluate(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const select=async(label,value)=>evaluate(`(()=>{const e=document.querySelector('[aria-label=${JSON.stringify(label)}]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const listReady=label=>until(`document.querySelector('[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-busy')==='false'`);
const shot=async(name)=>{const r=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(attempt,name),Buffer.from(r.data,'base64'));};
(async()=>{
 save();try{
  session=await openNativeSession(repo,f.runtime,{entryPath:f.entry});({call,evaluate,until}=session);
  await until(`document.querySelector('#ice-account-select')?.value===${JSON.stringify(f.account_id)}`);
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:950,deviceScaleFactor:1,mobile:false});
  await click('选题与排期');await until(`document.querySelector('[aria-label="本期期号"]')?.value==='1491'`);
  await until(`document.querySelector('.ice-editorial')?.innerText.includes('1500 个历史标题')`);
  const initial=observed();
  assert('summary_omits_title_transfer_but_preserves_counts',initial.filter(r=>r.method==='planning.context').every(r=>r.params.include_titles===false&&r.titles===0&&r.history===5));
  assert('create_view_does_not_load_full_topic_or_history_lists',initial.every(r=>!['outlines.list','history.list'].includes(r.method)));
  await until(`Boolean(${button('采用预设标题')})`);
  assert('current_issue_lookup_returns_no_bulk_available_list',observed().filter(r=>r.method==='outlines.match').every(r=>r.params.include_available===false&&r.available===0));
  await click('选题大纲');await listReady('已存期题列表');
  assert('topic_sql_page_has_ten_rows_and_real_total',await evaluate(`document.querySelectorAll('[aria-label="已存期题列表"] .ice-editorial__list-row').length===10&&document.querySelector('[aria-label="已存期题列表"]').innerText.includes('2000 条')`));
  await click('下一页','document.querySelector("[aria-label=已存期题列表]")');await listReady('已存期题列表');
  assert('next_topic_page_is_loaded_by_real_page_request',observed().some(r=>r.method==='outlines.list'&&r.params.page===1&&r.rows===10)&&await evaluate(`document.querySelector('[aria-label="已存期题列表"]').innerText.includes('观察排期 0011')`));
  await field('搜索预设期题','观察排期 2000');await until(`document.querySelectorAll('[aria-label="已存期题列表"] .ice-editorial__list-row').length===1`);await listReady('已存期题列表');
  assert('search_finds_issue_outside_previously_loaded_pages',await evaluate(`document.querySelector('[aria-label="已存期题列表"]').innerText.includes('观察排期 2000')`));
  await click('选用此期');await until(`document.querySelector('[aria-label="本期期号"]')?.value==='2000'&&document.querySelector('[aria-label="确认本期标题"]')?.value==='观察排期 2000'`);
  assert('chosen_issue_is_loaded_by_exact_lookup',observed().some(r=>r.method==='outlines.match'&&r.params.episode===2000&&r.available===0&&r.topic?.episode===2000));
  await click('发布记录');await listReady('历史文章列表');
  assert('history_sql_page_contains_only_ten_metadata_rows',await evaluate(`document.querySelectorAll('[aria-label="历史文章列表"] .ice-editorial__list-row').length===10&&document.querySelector('[aria-label="历史文章列表"]').innerText.includes('1500 条')`));
  await click('下一页','document.querySelector("[aria-label=历史文章列表]")');await listReady('历史文章列表');
  assert('history_next_page_is_real_and_contains_other_issues',observed().some(r=>r.method==='history.list'&&r.params.page===1&&r.rows===10)&&await evaluate(`document.querySelector('[aria-label="历史文章列表"]').innerText.includes('观察历史 1490')`));
  await field('搜索历史标题或期号','1498');await until(`document.querySelectorAll('[aria-label="历史文章列表"] .ice-editorial__list-row').length===1`);await listReady('历史文章列表');
  await click('查看原文');await until(`document.querySelectorAll('[role=dialog]').length===2&&[...document.querySelectorAll('[role=dialog]')].at(-1).innerText.includes('正文尾部 1498')`);
  assert('source_preview_loads_one_real_complete_body',observed().filter(r=>r.method==='history.get').length===1&&await evaluate(`[...document.querySelectorAll('[role=dialog]')].at(-1).innerText.includes('历史索引快照')`));
  await shot('history-preview.png');await click('关闭原文');await until(`document.querySelectorAll('[role=dialog]').length===1`);
  await select('筛选历史发布状态','published');await until(`document.querySelector('[aria-label="历史文章列表"]').innerText.includes('没有匹配的历史记录')`);await listReady('历史文章列表');
  assert('status_filter_excludes_unpublished_matches',await evaluate(`document.querySelectorAll('[aria-label="历史文章列表"] .ice-editorial__list-row').length===0`));
  await field('搜索历史标题或期号','');await until(`document.querySelector('[aria-label="历史文章列表"]').innerText.includes('1490 条')`);await listReady('历史文章列表');
  assert('clearing_search_keeps_the_selected_status',observed().some(r=>r.method==='history.list'&&r.params.query===''&&r.params.status==='published'&&r.rows===10));
  await select('筛选历史发布状态','draft');await until(`document.querySelector('[aria-label="历史文章列表"]').innerText.includes('10 条')`);await listReady('历史文章列表');
  assert('draft_filter_shows_only_draft_rows',await evaluate(`![...document.querySelectorAll('[aria-label="历史文章列表"] .ice-editorial__list-row')].some(e=>e.innerText.includes('已发布'))`));
  for(const width of [1280,800]){await call('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:false});assert('paged_history_no_overflow_'+width,await evaluate(`(()=>{const e=document.querySelector('[role=dialog]'),r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1;})()`));}
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:950,deviceScaleFactor:1,mobile:false});await shot('history-search.png');
  const requests=observed().filter(r=>['outlines.list','history.list'].includes(r.method));
  assert('every_ui_list_request_and_response_is_bounded',requests.length>=7&&requests.every(r=>r.params.page_size===10&&r.rows<=10));
  assert('history_paging_does_not_rescan_source_files',requests.filter(r=>r.method==='history.list').every(r=>r.params.refresh===false));
  const topicRequests=requests.filter(r=>r.method==='outlines.list');report.transfer={largest_topic_page_bytes:Math.max(...topicRequests.map(r=>r.bytes)),largest_history_page_bytes:Math.max(...requests.filter(r=>r.method==='history.list').map(r=>r.bytes))};
  assert('large_topic_notes_stay_under_100kb_per_page',report.transfer.largest_topic_page_bytes<100000);
  await click('关闭');await until(`!document.querySelector('[role=dialog]')`);
  const before=observed().length;await wait(2200);assert('closed_panel_stops_catalogue_requests',observed().length===before);
  report.errors.push(...session.errors);assert('no_uncaught_renderer_errors',report.errors.length===0);report.state='finished';report.success=true;
 }catch(error){report.state='failed';report.success=false;report.errors.push(error.stack);if(session)try{await shot('failure.png');}catch{}throw error;}
 finally{save();if(session)await session.close();}
})().then(()=>console.log(JSON.stringify({success:true,checks:Object.keys(report.checks).length,evidence_dir:attempt}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
