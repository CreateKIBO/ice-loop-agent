import * as React from 'react';
import { Banner,Button,Dialog,Spinner } from '../components/ui';
import { useAccountQuery } from '../data/client';
import type { RestoredQueue } from '../features/backup/backupModel';
import { backupSettingsStore } from './uiState';
const Settings=React.lazy(()=>import('../features/backup/BackupSettings').then(module=>({default:module.BackupSettings})));
export function BackupSettingsHost() {
  const open=backupSettingsStore.use();
  const [visited,setVisited]=React.useState(false);
  React.useEffect(()=>{if(open)setVisited(true);},[open]);
  // Keep receipts across close/reopen; never lose a successfully restored path.
  return open||visited?<React.Suspense fallback={<Dialog open={open} onOpenChange={backupSettingsStore.set} title="备份与恢复"><span role="status"><Spinner />正在载入…</span></Dialog>}><Settings /></React.Suspense>:null;
}
export function BackupRestoreNotice() {
  const queue=useAccountQuery<RestoredQueue>('backup.queue');
  if(!queue.data?.total)return null;
  return <div style={{padding:'6px 12px'}}><Banner tone="warning" title={`${queue.data.total} 项恢复的制作任务等待确认`}
    actions={<Button size="sm" onClick={()=>backupSettingsStore.set(true)}>查看并继续</Button>}>
    检查模型配置后，可在备份与恢复中逐项继续。
  </Banner></div>;
}
