const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
  const pending=new Map(),events={},calls={show:0,bounds:0,hide:0},classes=new Set(),storage=new Map();let sequence=0,observer,click;
  const workspace={scrollTop:900,classList:{add(name){classes.add(name);},remove(...names){names.forEach(n=>classes.delete(n));},toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},addEventListener(_name,fn){click=fn;}};
  const host={getBoundingClientRect:()=>({x:260,y:360,width:600,height:300})};
  const buttons={'collapse-chrome':{setAttribute(){}},'expand-view':{setAttribute(){}}};
  const context=vm.createContext({workspace,ui:{view:'browser'},pageHeading:()=>'',
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    document:{createElement(){return {};},querySelector(selector){if(selector==='#browser-host')return host;if(selector==='#browser-address-form')return {addEventListener(){}};if(selector==='.browser-tabs')return {insertBefore(){}};return buttons[selector.match(/data-browser-action="([^"]+)"/)?.[1]]||null;}},
    ResizeObserver:class{constructor(callback){observer=callback;}observe(){}disconnect(){}},MutationObserver:class{observe(){}},
    queueMicrotask,requestAnimationFrame(callback){const id=++sequence;pending.set(id,callback);return id;},cancelAnimationFrame(id){pending.delete(id);},
    window:{addEventListener(name,callback){events[name]=callback;},ice:{onBrowserRoute(){},onBrowserState(){},
      async browserShow(){calls.show++;return {cancelled:true};},async browserBounds(){calls.bounds++;return {ok:true};},async browserHide(){calls.hide++;}}}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../renderer/browser.js'),'utf8'),context);
  return {context,calls,workspace,pending,classes,storage,click:action=>click({target:{closest:selector=>selector==='[data-browser-action]'?{dataset:{browserAction:action}}:null}}),resize:()=>observer(),scroll:()=>events.scroll(),
    async paint(){const callbacks=[...pending.values()];pending.clear();for(const callback of callbacks)callback();await new Promise(resolve=>setImmediate(resolve));}};
}
test('scroll and resize cannot cancel opening the embedded browser',async()=>{
  const f=fixture();vm.runInContext('renderBrowser()',f.context);f.resize();f.scroll();await f.paint();
  assert.equal(f.workspace.scrollTop,0);assert.equal(f.calls.show,1);
});
test('leaving before the next frame cancels both mounting and bounds updates',async()=>{
  const f=fixture();vm.runInContext('renderBrowser()',f.context);f.resize();
  vm.runInContext('unmountBrowser()',f.context);await f.paint();
  assert.equal(f.calls.hide,1);assert.equal(f.calls.show,0);assert.equal(f.calls.bounds,0);
});

test('site opening does not depend on animation frames in an occluded window',async()=>{
  const f=fixture();vm.runInContext('renderBrowser()',f.context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.show,1);
});

test('collapsing description persists preference and does not reload the page',async()=>{
  const f=fixture();vm.runInContext('renderBrowser()',f.context);await f.paint();
  assert.equal(f.classes.has('browser-chrome-collapsed'),true);
  await f.click('collapse-chrome');await f.paint();
  assert.equal(f.classes.has('browser-chrome-collapsed'),false);assert.equal(f.storage.get('ice-browser-chrome'),'expanded');
  assert.equal(f.calls.show,1);
});

test('expanded web layout restores without changing saved sidebar or description preference',async()=>{
  const f=fixture();vm.runInContext('renderBrowser()',f.context);await f.paint();
  await f.click('expand-view');await f.paint();assert.equal(f.classes.has('browser-expanded'),true);
  await f.click('expand-view');await f.paint();assert.equal(f.classes.has('browser-expanded'),false);
  assert.equal(f.classes.has('browser-chrome-collapsed'),true);assert.equal(f.calls.show,1);
  vm.runInContext('unmountBrowser()',f.context);assert.equal(f.classes.has('browser-chrome-collapsed'),false);
});
