'use strict';
window.renderCapture=function(data){
  document.querySelector('#title').textContent=data.title;
  document.querySelector('#caption').textContent=data.caption;
  const root=document.querySelector('#runs');root.replaceChildren();
  for(const run of data.runs){
    const article=document.createElement('article'),head=document.createElement('h2');head.textContent=run.filename+' · '+run.run_id;article.append(head);
    for(const [label,value] of [['SOURCE',run.source],['INPUT',(run.stdin_events||[]).join('')],['STDOUT',run.stdout],['STDERR',run.stderr]]){
      if(!value&&label!=='STDOUT')continue;
      const title=document.createElement('div');title.className='label';title.textContent=label;
      const pre=document.createElement('pre'),lines=String(value||'(无输出)').split('\n');
      pre.textContent=lines.slice(0,75).join('\n')+(lines.length>75?'\n[截图显示前75行，完整内容见运行记录]':'');article.append(title,pre);
    }
    const proof=document.createElement('p');proof.textContent=`exit ${run.exit_code} · ${run.duration_ms} ms · code ${run.code_sha256.slice(0,12)} · output ${run.output_sha256.slice(0,12)}`;article.append(proof);root.append(article);
  }
  return Math.ceil(document.body.scrollHeight);
};
