export type SettingsDraft = { read:()=>{dirty:boolean;busy:boolean}; discard:()=>void };
/** One modal owns these references; closing/unmounting removes every owner. */
export function createSettingsDrafts() {
  const entries=new Map<string,SettingsDraft>(),listeners=new Set<()=>void>();
  let version=0;
  const notify=()=>{version++;listeners.forEach(listener=>listener());};
  return {
    version:()=>version,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    notify,
    register(key:string,entry:SettingsDraft){
      entries.set(key,entry);notify();
      return()=>{if(entries.get(key)===entry){entries.delete(key);notify();}};
    },
    status(){return {dirty:[...entries.values()].some(entry=>entry.read().dirty),busy:[...entries.values()].some(entry=>entry.read().busy)};},
    discard(){
      if([...entries.values()].some(entry=>entry.read().busy))throw Error('设置正在保存或测试，请等待完成后再离开');
      for(const entry of entries.values())if(entry.read().dirty)entry.discard();
      notify();
    },
  };
}
