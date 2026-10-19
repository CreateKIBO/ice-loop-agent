import * as React from 'react';
import { Banner,Button,Dialog,ErrorPanel,Spinner } from '../../components/ui';
import { CopyButton } from '../../components/CopyButton';
import { backupSettingsStore,settingsStore } from '../../app/uiState';
import { accountStore,flushAllDirty,queryClient,rpc,useAccountQuery,useCurrentAccount } from '../../data/client';
import { relaunchApp } from '../../data/desktop';
import type { BackupSummary,RestoredBackup,RestoredQueue } from './backupModel';
import { backupSize } from './backupModel';
import '../../styles/backup.css';

export function BackupSettings() {
  const open=backupSettingsStore.use(),account=useCurrentAccount();
  const [busy,setBusy]=React.useState(''),lock=React.useRef(false);
  const [error,setError]=React.useState(''),[saved,setSaved]=React.useState<BackupSummary|null>(null);
  const [review,setReview]=React.useState<BackupSummary|null>(null),[confirmed,setConfirmed]=React.useState(false);
  const [restored,setRestored]=React.useState<RestoredBackup|null>(null);
  const queue=useAccountQuery<RestoredQueue>('backup.queue',undefined,{enabled:open,staleTime:0,gcTime:0});
  const currentPath=queue.data?.runtime_root;
  const operation=async(label:string,run:()=>Promise<void>)=>{
    if(lock.current)return;
    lock.current=true;setBusy(label);setError('');
    try{await run();}catch(cause){setError((cause as Error).message||'操作未完成，请重试');}
    finally{lock.current=false;setBusy('');}
  };
  const create=()=>operation('选择保存位置后，将打包并校验工作台资料…',async()=>{
    await flushAllDirty();
    if(!window.ice?.createBackup)throw Error('请在桌面程序中使用备份功能');
    const result=await window.ice.createBackup();if(result)setSaved(result);
  });
  const inspect=()=>operation('选择备份后，将校验文件、数据库和迁移…',async()=>{
    setReview(null);setConfirmed(false);
    if(!window.ice?.inspectBackup)throw Error('请在桌面程序中选择备份文件');
    const result=await window.ice.inspectBackup();if(result)setReview(result);
  });
  const restore=()=>operation('选择父目录后，将恢复并复检资料；请保持窗口打开…',async()=>{
    if(!review?.token||!confirmed)return;
    await flushAllDirty();
    if(!window.ice?.restoreBackup)throw Error('请在桌面程序中恢复备份');
    try{
      const result=await window.ice.restoreBackup(review.token);
      if(result){setRestored(result);setReview(null);setConfirmed(false);}
    }catch(cause){setReview(null);setConfirmed(false);throw cause;}
  });
  const activate=()=>operation('正在重新保存下次启动的工作目录…',async()=>{
    await flushAllDirty();
    if(!restored?.activation_token||!window.ice?.activateRestoredBackup)throw Error('请保留恢复目录，再重新打开程序检查');
    setRestored(await window.ice.activateRestoredBackup(restored.activation_token));
  });
  const resume=(task:RestoredQueue['tasks'][number])=>operation('正在恢复所选制作任务…',async()=>{
    await flushAllDirty();
    if(accountStore.get()!==task.account_id)throw Error('公众号已切换，请刷新后继续');
    await rpc('backup.resume_queue',task);
    await queue.refetch();
    await queryClient.invalidateQueries({queryKey:['ice',account,'jobs.list']});
  });
  return <Dialog open={open} onOpenChange={next=>{if(!lock.current)backupSettingsStore.set(next);}}
    title="备份与恢复" width={780}
    description="备份整个本地工作台，包含所有公众号、文章、草稿和托管配图。恢复时新建目录，完成后由你决定何时重启使用。"
    footer={<Button disabled={Boolean(busy)} onClick={()=>backupSettingsStore.set(false)}>关闭</Button>}>
    <div className="ice-backup" aria-busy={Boolean(busy)}>
      <p className="ice-backup__path">当前工作目录：<span>{currentPath||'正在读取…'}</span></p>
      <div className="ice-backup__actions">
        <Button variant="primary" disabled={Boolean(busy)} onClick={()=>void create()}>创建完整备份</Button>
        <Button disabled={Boolean(busy)} onClick={()=>void inspect()}>选择备份并校验</Button>
      </div>
      {busy&&<div className="ice-backup__progress" role="status" aria-live="polite"><Spinner />{busy}</div>}
      {error&&<ErrorPanel title="操作未完成" detail={error} onDismiss={()=>setError('')} />}
      <p className="ice-backup__hint">API Key、网页登录、日志、浏览器缓存不进入备份。外部只读文章目录不复制，已导入的历史正文快照保留。恢复后需重新配置并测试模型，待执行制作任务会暂停等待确认。</p>
      {saved&&<section className="ice-backup__card" aria-label="备份保存结果">
        <h3>备份已保存并通过校验</h3><Summary value={saved} />
        <p className="ice-backup__path">{saved.file_path}</p>
        {saved.file_path&&<CopyButton text={saved.file_path} label="复制备份路径" />}
      </section>}
      {review&&<section className="ice-backup__card" aria-label="备份恢复预览">
        <h3>备份预览 · 尚未恢复</h3><Summary value={review} />
        <p className="ice-backup__hint">确认后选择一个 C 盘之外的父目录。程序会在其中新建工作目录；当前资料保留。预览有效期为 10 分钟，文件变化后需重新校验。</p>
        <label className="ice-backup__confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={e=>setConfirmed(e.target.checked)} />我已确认备份内容，恢复到新目录并设为下次启动使用</label>
        <Button variant="primary" disabled={Boolean(busy)||!confirmed||!review.database_checked} onClick={()=>void restore()}>恢复到新目录</Button>
      </section>}
      {restored&&<section className="ice-backup__card" aria-label="恢复结果">
        <h3>资料已恢复到新目录</h3><p className="ice-backup__path">{restored.runtime_root}</p>
        <CopyButton text={restored.runtime_root} label="复制恢复目录" />
        {restored.selection_error?<Banner tone="warning" title="目录切换尚未完成">{restored.selection_error}</Banner>:<p>下次启动将使用恢复的资料。当前窗口仍使用原工作目录。</p>}
        {restored.restart_required?<Button variant="primary" disabled={Boolean(busy)} onClick={()=>void operation('正在保存修改并重启…',async()=>{await flushAllDirty();await relaunchApp();})}>保存当前修改并重启</Button>:<Button disabled={Boolean(busy)} onClick={()=>void activate()}>重试切换目录</Button>}
      </section>}
      {queue.error&&<ErrorPanel title="待恢复任务读取失败" detail={queue.error.message} onRetry={()=>void queue.refetch()} />}
      {Boolean(queue.data?.total)&&<section className="ice-backup__card" aria-label="恢复后暂停的任务">
        <h3>当前公众号有 {queue.data!.total} 项恢复后暂停的任务</h3>
        <p className="ice-backup__hint">先检查模型配置。点击继续后进入原制作流程，可能调用你配置的模型；已经绑定的文章会继续使用原任务。</p>
        <Button size="sm" disabled={Boolean(busy)} onClick={()=>{backupSettingsStore.set(false);settingsStore.set(true);}}>检查模型配置</Button>
        {queue.data!.tasks.map(task=><div key={task.task_id} className="ice-backup__task"><span>{task.title}</span><Button size="sm" disabled={Boolean(busy)} aria-label={`继续任务：${task.title}`} onClick={()=>void resume(task)}>继续此任务</Button></div>)}
        {queue.data!.total>queue.data!.tasks.length&&<p className="ice-backup__hint">先显示前 {queue.data!.tasks.length} 项，处理后会载入其余任务。</p>}
      </section>}
    </div>
  </Dialog>;
}
function Summary({value}:{value:BackupSummary}) {
  return <><dl className="ice-backup__summary">
    <div><dt>备份时间</dt><dd>{new Date(value.created_at).toLocaleString()}</dd></div>
    <div><dt>程序版本</dt><dd>{value.app_version}</dd></div>
    <div><dt>文件与解压大小</dt><dd>{value.files} 个 · {backupSize(value.bytes)}</dd></div>
    <div><dt>数据库与迁移</dt><dd>{value.database_checked?`已校验 · schema ${value.database_schema}`:'尚未校验'}</dd></div>
  </dl><p>公众号：{value.accounts.map(a=>a.name).join('、')}</p>
  <details><summary>文件校验摘要与排除项</summary><p className="ice-backup__path">SHA256 {value.package_hash}</p><p className="ice-backup__hint">{value.excluded.join('；')}</p></details></>;
}
