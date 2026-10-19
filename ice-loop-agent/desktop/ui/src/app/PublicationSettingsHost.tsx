import * as React from 'react';
import { Dialog,Spinner } from '../components/ui';
import { useCurrentAccount } from '../data/client';
import { publicationSettingsStore,publicationEntryStore } from './uiState';
const Settings=React.lazy(()=>import('../features/publication/PublicationSettings').then(module=>({default:module.PublicationSettings})));
export function PublicationSettingsHost() {
  const open=publicationSettingsStore.use(),account=useCurrentAccount(),previous=React.useRef(account);
  const entry=publicationEntryStore.use();
  React.useEffect(()=>{if(!open)publicationEntryStore.set('identity');},[open]);
  React.useEffect(()=>{if(previous.current!==account){publicationSettingsStore.set(false);previous.current=account;}},[account]);
  return open?<React.Suspense fallback={<Dialog open onOpenChange={publicationSettingsStore.set} title="公众号与品牌"><div role="status"><Spinner />正在载入公众号设置…</div></Dialog>}>
    <Settings key={account} entry={entry} />
  </React.Suspense>:null;
}
