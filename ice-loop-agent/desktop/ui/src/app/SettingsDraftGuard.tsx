import * as React from 'react';
import { dirtyStore,registerDirtyFlush,useCurrentAccount } from '../data/client';
import type { createSettingsDrafts } from './settingsDrafts';
export const SettingsDraftContext=React.createContext<ReturnType<typeof createSettingsDrafts>|null>(null);

export function useSettingsDraft(id:string,label:string,dirty:boolean,busy:boolean,discard:()=>void) {
  const registry=React.useContext(SettingsDraftContext),account=useCurrentAccount(),key=`model-settings:${account}:${id}`;
  const current=React.useRef({dirty,busy,discard});current.current={dirty,busy,discard};
  React.useEffect(()=>{
    if(!registry)return;
    const remove=registry.register(key,{read:()=>current.current,discard:()=>{
      current.current.discard();current.current.dirty=false;dirtyStore.markClean(key);
    }});
    const off=registerDirtyFlush(key,()=>{
      if(current.current.busy)throw Error(`${label}正在处理，请等待完成`);
      if(current.current.dirty)throw Error(`${label}有未保存修改，请保存或放弃后继续`);
    });
    return()=>{remove();off();dirtyStore.markClean(key);};
  },[key,label,registry]);
  React.useLayoutEffect(()=>{
    if(dirty||busy)dirtyStore.markDirty(key);else dirtyStore.markClean(key);
  });
  React.useEffect(()=>{registry?.notify();},[dirty,busy,key,registry]);
  return {
    changed(){current.current.dirty=true;dirtyStore.markDirty(key);registry?.notify();},
    processing(){current.current.busy=true;dirtyStore.markDirty(key);registry?.notify();},
  };
}
