'use strict';
// One reusable viewer; original images are fetched on demand and released on close.
(() => {
  const selector='.asset-visual img,.candidate-full-image,.recommend-item img,.prompt-reference-image img,.markdown-preview img';
  let ticket=0, dialog, image, viewport, scale=1, fit=1, x=0, y=0, drag, ownerContext, viewportSize;
  const context=()=>`${ui.bootstrap?.account?.id}|${ui.view}|${ui.currentJob}`;
  const paint=()=>{
    image.style.transform=`translate(-50%,-50%) translate(${x}px,${y}px) scale(${scale})`;
    dialog.querySelector('[data-image-percent]').textContent=Math.round(scale*100)+'%';
  };
  const resize=(force=false)=>{
    if(!image?.naturalWidth)return;
    const size=viewport.clientWidth+'x'+viewport.clientHeight;
    if(!force&&size===viewportSize)return;
    viewportSize=size;
    fit=Math.min(1,(viewport.clientWidth-32)/image.naturalWidth,(viewport.clientHeight-32)/image.naturalHeight);
    scale=fit;x=0;y=0;paint();
  };
  function create(){
    dialog=document.createElement('dialog');dialog.id='image-viewer';dialog.className='image-viewer';
    dialog.setAttribute('aria-label','原图查看');
    dialog.innerHTML='<header><div><strong data-image-title></strong><small data-image-info role="status">正在读取原图…</small></div><nav aria-label="图片缩放"><button type="button" class="button secondary small" data-image-command="out" aria-label="缩小">−</button><span data-image-percent>100%</span><button type="button" class="button secondary small" data-image-command="in" aria-label="放大">＋</button><button type="button" class="button secondary small" data-image-command="fit">适应窗口</button><button type="button" class="button secondary small" data-image-command="actual">原始大小</button><button type="button" class="icon-button" data-image-command="close" aria-label="关闭原图">×</button></nav></header><div class="image-viewer-viewport"><img alt="" draggable="false" hidden></div><footer>滚轮缩放 · 按住图片拖动 · 双击切换原始大小 · Esc 关闭</footer>';
    document.body.append(dialog);image=dialog.querySelector('img');viewport=dialog.querySelector('.image-viewer-viewport');
    image.addEventListener('load',()=>{image.hidden=false;image.style.width=image.naturalWidth+'px';image.style.height=image.naturalHeight+'px';dialog.querySelector('[data-image-info]').textContent=`${image.naturalWidth} × ${image.naturalHeight} · 原始图片`;resize(true);});
    image.addEventListener('error',()=>{image.hidden=true;dialog.querySelector('[data-image-info]').textContent='图片读取失败，请重新导入';});
    const release=()=>{ticket++;image.hidden=true;image.removeAttribute('src');drag=null;};
    dialog.addEventListener('close',()=>{if(!dialog.open)release();});
    dialog.addEventListener('click',event=>{
      const command=event.target.closest('[data-image-command]')?.dataset.imageCommand;
      if(command==='close'){release();dialog.close();return;}
      if(!image.naturalWidth)return;
      if(command==='fit')resize(true);
      else if(command==='actual'){scale=1;x=0;y=0;paint();}
      else if(command==='in'||command==='out'){scale=Math.max(Math.min(fit,0.05),Math.min(8,scale*(command==='in'?1.25:0.8)));paint();}
    });
    viewport.addEventListener('wheel',event=>{
      event.preventDefault();if(!image.naturalWidth)return;
      const previous=scale,bounds=viewport.getBoundingClientRect();
      scale=Math.max(Math.min(fit,0.05),Math.min(8,scale*Math.exp(-event.deltaY*0.002)));
      x-=(event.clientX-bounds.left-viewport.clientWidth/2-x)*(scale/previous-1);
      y-=(event.clientY-bounds.top-viewport.clientHeight/2-y)*(scale/previous-1);paint();
    },{passive:false});
    viewport.addEventListener('pointerdown',event=>{if(event.button!==0||!image.naturalWidth)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY};viewport.setPointerCapture(event.pointerId);});
    viewport.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;x+=event.clientX-drag.x;y+=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;paint();});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(name,()=>{drag=null;});
    viewport.addEventListener('dblclick',()=>{scale=Math.abs(scale-1)<0.001?fit:1;x=0;y=0;paint();});
    dialog.addEventListener('keydown',event=>{
      const command={'+':'in','=':'in','-':'out','0':'fit','1':'actual'}[event.key];
      if(command){event.preventDefault();dialog.querySelector(`[data-image-command="${command}"]`).click();}
    });
    new ResizeObserver(()=>{if(dialog.open)resize();}).observe(viewport);
  }
  async function open(target){
    const resource=target.dataset.resourceImage||target.dataset.recImage||target.dataset.promptReference;
    const candidate=target.dataset.candidateId||Object.entries(ui.images).find(([,source])=>source===target.src)?.[0];
    const jobId=target.dataset.imageJob||ui.currentJob;
    if(!resource&&!target.src.startsWith('data:image/'))return;
    if(!dialog)create();
    const current=++ticket,account=activeAccount().id;
    ownerContext=context();
    image.hidden=true;image.removeAttribute('src');
    dialog.querySelector('[data-image-title]').textContent=target.alt||'配图原图';
    dialog.querySelector('[data-image-info]').textContent='正在读取原图…';
    if(!dialog.open)dialog.showModal();
    try{
      const source=resource?(await api('resources.preview',{resource_id:resource,original:true})).data_url:
        candidate&&jobId?await api('assets.preview',{job_id:jobId,candidate_id:candidate,original:true}):target.src;
      if(current!==ticket||!dialog.open||account!==activeAccount().id)return;
      image.src=source;
    }catch(error){if(current===ticket&&dialog.open)dialog.querySelector('[data-image-info]').textContent=error.message;}
  }
  const decorate=()=>{
    document.querySelectorAll(selector).forEach(target=>{
      target.tabIndex=0;target.setAttribute('role','button');target.setAttribute('aria-label',`放大查看：${target.alt||'图片'}`);target.title='点击查看原图，可缩放和拖动';
    });
    if(dialog?.open&&ownerContext!==context())dialog.close();
  };
  document.addEventListener('click',event=>{const target=event.target.closest(selector);if(target){event.preventDefault();open(target);if(dialog)dialog.dataset.account=activeAccount().id;}});
  document.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)&&event.target.matches(selector)){event.preventDefault();open(event.target);if(dialog)dialog.dataset.account=activeAccount().id;}});
  // Observe inserted previews only; attribute writes here cannot retrigger the observer.
  new MutationObserver(decorate).observe(document.body,{childList:true,subtree:true});
  decorate();
})();
