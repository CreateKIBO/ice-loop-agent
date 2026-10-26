import * as React from 'react';
import {motion} from 'motion/react';
import {Button,ErrorPanel,Banner} from '../../components/ui';
import {useActivityReducedMotion} from '../../components/ActivityRail';
import {CopyButton} from '../../components/CopyButton';
import {rpc,useAccountQuery,flushAllDirty} from '../../data/client';
import {backupSize,type BackupSummary} from './backupModel';
type Point={point_id:string;record_hash:string;state:'ready'|'failed'|'creating';reason:string;created_at:string;source_schema:number;target_schema:number;archive_bytes:number;files:number;can_delete:boolean;error?:string};
type Points={directory:string;points:Point[];managed_bytes:number;unknown_count:number;truncated:boolean};
type Props={busy:boolean;operation:(label:string,run:()=>Promise<void>)=>Promise<void>;onReview:(value:BackupSummary|null)=>void};
export function RecoveryPointList({busy,operation,onReview}:Props){
  const points=useAccountQuery<Points>('recovery.list',undefined,{staleTime:0,gcTime:0});
  const [notice,setNotice]=React.useState(''),reduced=useActivityReducedMotion();
  const reload=async()=>{const result=await points.refetch();if(result.error)setNotice('操作已完成，但恢复点列表刷新失败。请刷新列表核实，勿重复创建。');};
  const create=()=>operation('正在保留完整工作区恢复点并校验…',async()=>{
    await flushAllDirty();await rpc('recovery.create');setNotice('完整恢复点已保存，当前所有公众号资料已保留。');await reload();
  });
  const inspect=(point:Point)=>operation('正在逐项校验恢复点，请保持窗口打开…',async()=>{
    onReview(null);
    if(!window.ice?.inspectRecoveryPoint)throw Error('请在桌面程序中校验恢复点');
    const summary=await window.ice.inspectRecoveryPoint(point.point_id);if(summary)onReview(summary);
  });
  const remove=(point:Point)=>operation('等待删除确认后，校验并删除所选恢复点…',async()=>{
    if(!window.ice?.deleteRecoveryPoint)throw Error('请在桌面程序中管理恢复点');
    const result=await window.ice.deleteRecoveryPoint(point.point_id,point.record_hash);
    if(result){setNotice('所选恢复点已删除，当前工作资料保留。');await reload();}
  });
  return <section className="ice-backup__card" aria-label="升级恢复点">
    <h3>升级恢复点</h3><p className="ice-backup__hint">数据库升级前自动保留所有公众号的文章、草稿与托管配图。恢复时新建目录。API Key、网页登录及缓存不保留，请另外保存凭据。</p>
    <div className="ice-backup__actions"><Button disabled={busy} onClick={()=>void create()}>立即创建恢复点</Button><Button disabled={busy||points.isFetching} onClick={()=>void points.refetch()}>刷新列表</Button><Button disabled={busy||!points.data||(points.data.points.length===0&&points.data.unknown_count===0)} onClick={()=>void operation('正在打开恢复点目录…',async()=>{if(!window.ice?.openRecoveryFolder)throw Error('请在桌面程序中使用');await window.ice.openRecoveryFolder();})}>打开目录</Button></div>
    {notice&&<Banner tone="info" title="恢复点操作结果">{notice}</Banner>}
    {points.error&&<ErrorPanel title="恢复点读取失败" detail={points.error.message} onRetry={()=>void points.refetch()} />}
    {points.data&&<><p className="ice-backup__hint">已识别的恢复点备份占用 {backupSize(points.data.managed_bytes)}。历史点由你决定保留或删除；不自动清理。</p><CopyButton text={points.data.directory} label="复制恢复点目录" />
      {!points.data.points.length&&<p className="ice-backup__hint">还没有恢复点。下次数据库升级前会自动创建，也可立即保留一份。</p>}
      {(points.data.unknown_count>0||points.data.truncated)&&<Banner tone="warning" title="部分内容需要检查">{points.data.unknown_count} 项未识别内容原样保留。{points.data.truncated?'点数量较多，列表仅展示有限项。':''}程序不会删除未知文件或未完成目录。</Banner>}
      <div className="ice-backup__points">{points.data.points.map(point=><motion.article key={point.point_id} className="ice-backup__point" initial={reduced?false:{opacity:0}} animate={{opacity:1}} transition={{duration:0.16}}>
        <div><strong>{new Date(point.created_at).toLocaleString()}</strong><p className="ice-backup__hint">{point.reason==='pre-migration'?'升级前自动保存':'手动保存'} · {point.state==='ready'?'已完成':point.state==='failed'?'创建未完成':'上次处理未完成'} · {backupSize(point.archive_bytes)}</p>
        {point.state==='ready'&&<p className="ice-backup__hint">{point.files} 个文件 · schema {point.source_schema} → {point.target_schema}</p>}{point.error&&<p className="ice-backup__hint">{point.error}</p>}</div>
        <div className="ice-backup__actions"><Button size="sm" disabled={busy||point.state!=='ready'} onClick={()=>void inspect(point)}>校验并预览</Button><Button size="sm" variant="danger" disabled={busy||!point.can_delete} onClick={()=>void remove(point)}>删除恢复点</Button></div>
      </motion.article>)}</div>
    </>}
  </section>;
}
