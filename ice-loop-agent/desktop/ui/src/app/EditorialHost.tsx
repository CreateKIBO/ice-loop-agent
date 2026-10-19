import * as React from 'react';
import { Dialog,Spinner } from '../components/ui';
import { useCurrentAccount } from '../data/client';
import { editorialStore } from './uiState';
const Workspace=React.lazy(()=>import('../features/editorial/EditorialWorkspace').then(module=>({default:module.EditorialWorkspace})));
export function EditorialHost() {
  const open=editorialStore.use(),account=useCurrentAccount(),previous=React.useRef(account);
  React.useEffect(()=>{if(previous.current!==account){editorialStore.set(false);previous.current=account;}},[account]);
  return open?<React.Suspense fallback={<Dialog open onOpenChange={editorialStore.set} title="选题与排期"><span role="status"><Spinner />正在载入…</span></Dialog>}><Workspace key={account} /></React.Suspense>:null;
}
