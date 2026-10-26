import * as React from 'react';
import { motion,MotionConfig,MotionConfigContext } from 'motion/react';

/** Subscribe only while a live indicator/clock is mounted. No polling. */
export function useDocumentVisible() {
  return React.useSyncExternalStore(
    React.useCallback((notify:()=>void)=>{
      document.addEventListener('visibilitychange',notify);
      return ()=>document.removeEventListener('visibilitychange',notify);
    },[]),
    ()=>typeof document==='undefined'||document.visibilityState!=='hidden',
    ()=>true,
  );
}

// The installed Motion hook snapshots the initial preference. Observe changes
// explicitly so an already-running indicator also stops when settings change.
const preferenceListeners=new Set<()=>void>();
let media:MediaQueryList|undefined,observer:MutationObserver|undefined;
const notifyPreference=()=>preferenceListeners.forEach(notify=>notify());
function readPreference() {
  if(typeof window==='undefined')return true;
  media??=window.matchMedia('(prefers-reduced-motion: reduce)');
  return media.matches||document.documentElement.dataset.reduceMotion==='true';
}
function subscribePreference(notify:()=>void) {
  preferenceListeners.add(notify);
  if(preferenceListeners.size===1){
    readPreference();media?.addEventListener('change',notifyPreference);
    observer=new MutationObserver(notifyPreference);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-reduce-motion']});
  }
  return ()=>{
    preferenceListeners.delete(notify);
    if(!preferenceListeners.size){media?.removeEventListener('change',notifyPreference);observer?.disconnect();observer=undefined;}
  };
}
export function useActivityReducedMotion() {
  const reduced=React.useSyncExternalStore(subscribePreference,readPreference,()=>true);
  const policy=React.useContext(MotionConfigContext).reducedMotion;
  return reduced||policy==='always';
}

const RUNNING={x:['-100%','250%']},STILL={x:'0%'};
const LOOP={duration:1.4,ease:'linear' as const,repeat:Infinity},INSTANT={duration:0};

/** Indeterminate activity, never a made-up completion percentage. */
export const ActivityRail=React.memo(function ActivityRail({active=true,tone='working',compact=false}:{
  active?:boolean;tone?:'working'|'success'|'warning'|'danger';compact?:boolean;
}) {
  const reduced=useActivityReducedMotion(),visible=useDocumentVisible();
  const animate=active&&!reduced&&visible;
  return <span aria-hidden="true" className={'ice-activity-rail ice-activity-rail--'+tone+(compact?' ice-activity-rail--compact':'')}
    data-active={active} data-animated={animate}>
    {/* Local policy avoids a cached Motion visual element; the live preference
        above controls whether a loop can exist, including parent always. */}
    <MotionConfig reducedMotion="never"><motion.span key={animate?'moving':'still'} className="ice-activity-rail__fill"
      initial={false}
      animate={animate?RUNNING:STILL}
      style={{width:animate?'40%':'100%'}}
      transition={animate?LOOP:INSTANT} /></MotionConfig>
  </span>;
});
