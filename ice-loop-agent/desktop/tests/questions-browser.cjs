// Real React StrictMode / Chrome. Owned clarification data and memory delivery; no native IPC/models.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),esbuild=require('esbuild'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),ui=path.join(root,'desktop/ui');
const parent=path.join(root,'.test-tmp/questions-browser');fs.mkdirSync(parent,{recursive:true});
const folder=fs.mkdtempSync(path.join(parent,'run-'));
const report={scope:'Real React/Chrome, offline memory delivery',checks:{},errors:[]};
let server,browser,page;
async function check(name,run){try{await run();report.checks[name]=true;}catch(error){report.checks[name]=error.stack;process.exitCode=1;await page.screenshot({path:path.join(folder,name+'.png')}).catch(()=>{});}}
async function run(){
  esbuild.buildSync({stdin:{contents:`
    import React from 'react';import{createRoot}from'react-dom/client';
    import{QuestionDock}from'./features/chat/QuestionDock';import{accountStore}from'./data/client';
    import './styles/tokens.css';
    accountStore.set('owned');window.sent=[];
    window.row={id:'question-owned',role:'assistant',status:'completed',content:'请确认',metadata:{questions:[
      {id:'parts',header:'材料',question:'要保留哪些部分？',multiple:true,options:['甲'.repeat(180),'乙'.repeat(180),'丙'.repeat(180),'丁'.repeat(180)]},
      {id:'purpose',header:'目的',question:'文章的目标是什么？',options:[]}]}};
    const delivery={busy:false,pending:null,send:async(payload,source)=>{window.sent.push({payload,source});return true;}};
    createRoot(document.getElementById('root')).render(<React.StrictMode><QuestionDock row={window.row} account='owned' conversation='conversation-owned' delivery={delivery} disabled={false}/></React.StrictMode>);
  `,resolveDir:path.join(ui,'src'),loader:'tsx'},bundle:true,outfile:path.join(folder,'app.js'),jsx:'automatic',logLevel:'silent'});
  server=http.createServer((req,res)=>{if(['/app.js','/app.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(folder,req.url.slice(1))));}
    else{res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await chromium.launch({executablePath:process.env.ICE_TEST_CHROME||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  page=await browser.newPage({viewport:{width:1100,height:760},reducedMotion:'reduce'});page.setDefaultTimeout(5000);
  page.on('pageerror',error=>report.errors.push(error.message));
  const fresh=async()=>{await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>localStorage.clear());await page.reload();await page.getByRole('group',{name:'要保留哪些部分？',exact:true}).waitFor();};
  const fillReview=async()=>{
    await page.getByRole('checkbox').first().click();
    await page.getByRole('button',{name:'下一题',exact:true}).click();
    await page.getByLabel('你的回答',{exact:true}).fill('解释操作步骤');
    await page.getByRole('button',{name:'检查并提交',exact:true}).click();
    await page.getByRole('button',{name:'提交回答并继续',exact:true}).waitFor();
  };
  await check('ime_confirmation_does_not_navigate',async()=>{
    await fresh();const field=page.getByLabel('补充其他（可选）',{exact:true});await field.fill('中文组词');
    await field.dispatchEvent('keydown',{key:'Enter',code:'Enter',ctrlKey:true,isComposing:true,keyCode:229});
    await page.waitForTimeout(80);
    assert.equal(await page.getByRole('group',{name:'要保留哪些部分？',exact:true}).count(),1);
  });
  await check('ime_escape_does_not_collapse',async()=>{
    await fresh();const field=page.getByLabel('补充其他（可选）',{exact:true});await field.focus();
    await field.dispatchEvent('keydown',{key:'Escape',code:'Escape',isComposing:true,keyCode:229});
    await page.waitForTimeout(50);assert.equal(await page.locator('.ice-qbox--collapsed').count(),0);
  });
  await check('review_summary_enter_does_not_submit',async()=>{
    await fresh();await fillReview();await page.locator('.ice-qbox__more summary').focus();await page.keyboard.press('Enter');
    await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>window.sent.length),0);
    assert.equal(await page.locator('.ice-qbox__more').evaluate(el=>el.open),true);
    await page.getByRole('button',{name:'提交回答并继续',exact:true}).click();
    await page.waitForFunction(()=>window.sent.length===1);
    assert.equal(await page.evaluate(()=>window.sent[0].payload.clarification_answers.purpose),'解释操作步骤');
  });
  await check('long_multi_select_draft_survives_reload',async()=>{
    await fresh();for(let i=0;i<4;i++)await page.getByRole('checkbox').nth(i).click();
    const value='引号"与换行\n'.repeat(250).slice(0,1800);
    await page.getByLabel('补充其他（可选）',{exact:true}).fill(value);
    await page.waitForTimeout(30);await page.reload();
    await page.getByRole('button',{name:/材料$/,exact:false}).click();
    await page.getByRole('checkbox').first().waitFor();
    for(let i=0;i<4;i++)assert.equal(await page.getByRole('checkbox').nth(i).getAttribute('aria-checked'),'true');
    assert.equal(await page.getByLabel('补充其他（可选）',{exact:true}).inputValue(),value);
  });
  await check('next_question_keeps_keyboard_focus',async()=>{
    await fresh();await page.getByRole('checkbox').first().click();await page.getByRole('button',{name:'下一题',exact:true}).click();
    await page.getByLabel('你的回答',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.activeElement?.tagName==='TEXTAREA'&&document.activeElement.id.endsWith('-purpose'));
    await page.keyboard.type('keyboard answer');assert.equal(await page.getByLabel('你的回答',{exact:true}).inputValue(),'keyboard answer');
  });
  await check('overlong_answer_blocks_submission_without_losing_input',async()=>{
    await fresh();for(let i=0;i<4;i++)await page.getByRole('checkbox').nth(i).click();
    const value='补'.repeat(1800);await page.getByLabel('补充其他（可选）',{exact:true}).fill(value);
    await page.getByRole('alert').filter({hasText:'最多 2000 字'}).waitFor();
    await page.getByRole('button',{name:'下一题',exact:true}).click();
    await page.getByLabel('你的回答',{exact:true}).fill('说明步骤');await page.getByRole('button',{name:'检查并提交',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'提交回答并继续',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:/材料$/}).click();
    assert.equal(await page.getByLabel('补充其他（可选）',{exact:true}).inputValue(),value);
    assert.equal(await page.evaluate(()=>window.sent.length),0);
  });
  await check('narrow_question_controls_reachable',async()=>{
    await fresh();await page.setViewportSize({width:390,height:500});
    await page.getByRole('checkbox').first().click();await page.getByLabel('补充其他（可选）',{exact:true}).fill('窄屏补充');
    await page.getByRole('button',{name:'下一题',exact:true}).click();await page.getByLabel('你的回答',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:path.join(folder,'questions-narrow.png')});
  });
  assert.deepEqual(report.errors,[]);
}
run().catch(error=>{report.failure=error.stack;process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({folder,...report},null,2));
});
