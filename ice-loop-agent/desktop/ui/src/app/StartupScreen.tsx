import * as React from 'react';
import {MotionConfig,motion} from 'motion/react';
import {ActivityRail,useActivityReducedMotion} from '../components/ActivityRail';
import {Button} from '../components/ui';
import {backupSize} from '../features/backup/backupModel';
import '../styles/startup.css';
export type StartupState={revision:number;phase:string;cancelable:boolean;files_done?:number;bytes_done?:number;pages_done?:number;pages_total?:number};
const labels:Record<string,string>={connecting:'正在连接本地引擎',initialize_workspace:'正在检查工作区数据库',snapshot_database:'正在保留数据库快照',scan_files:'正在检查文件与磁盘空间',copy_files:'正在保留文章与配图',verify_archive:'正在校验恢复点',verify_files:'正在逐项校验文件',verify_database:'正在检查恢复点数据库',save_recovery_point:'正在保存完整恢复点',upgrade_database:'恢复点已保存，正在升级数据库',ready:'工作区已就绪',cancelling:'正在取消并清理本次临时文件'};
export function StartupScreen(){
  const [state,setState]=React.useState<StartupState>({revision:0,phase:'connecting',cancelable:true});
  const [error,setError]=React.useState(''),[cancelling,setCancelling]=React.useState(false);
  const busy=React.useRef(false),reduced=useActivityReducedMotion();
  React.useEffect(()=>{
    let alive=true;const accept=(value:StartupState)=>{if(alive)setState(old=>value.revision>=old.revision?value:old);};
    const stop=window.ice?.onStartupProgress?.(accept);
    void window.ice?.startupState?.().then(accept).catch(()=>{if(alive)setError('启动状态暂时无法读取，请保持窗口打开。');});
    return()=>{alive=false;stop?.();};
  },[]);
  const cancel=async()=>{if(busy.current)return;busy.current=true;setError('');try{const result=await window.ice?.cancelStartup?.();if(result?.cancelled)setCancelling(true);}catch{setError('取消请求未完成，请重试。');}finally{busy.current=false;}};
  const label=labels[state.phase]||'正在准备工作区';
  return <MotionConfig reducedMotion="user"><main className="ice-startup"><motion.section initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:0.16}}>
    <span className="ice-startup__mark" aria-hidden>i</span><p className="ice-startup__eyebrow">ICE LOOP STUDIO</p>
    <h1>准备你的创作空间</h1><p role="status" aria-live="polite">{label}</p><ActivityRail active={state.phase!=='ready'} />
    {typeof state.bytes_done==='number'&&<p className="ice-startup__detail">已处理 {backupSize(state.bytes_done)}{typeof state.files_done==='number'?` · ${state.files_done} 个文件`:''}</p>}
    {typeof state.pages_total==='number'&&state.pages_total>0&&<p className="ice-startup__detail">数据库页 {state.pages_done||0} / {state.pages_total}</p>}
    <p className="ice-startup__detail">数据库需要升级时，先保留文章、草稿和托管配图的完整恢复点。大图库可能需要几分钟。</p>
    {error&&<p role="alert">{error}</p>}<Button disabled={!state.cancelable||cancelling} onClick={()=>void cancel()}>{cancelling?'正在取消…':'取消启动'}</Button>
    {!state.cancelable&&['upgrade_database','initialize_workspace'].includes(state.phase)&&<p className="ice-startup__detail">正在写入数据库，请等待完成。</p>}
  </motion.section></main></MotionConfig>;
}
