import * as React from 'react';
import { Dialog, Spinner } from '../components/ui';
import { settingsStore } from './uiState';
const Settings = React.lazy(() => import('./ModelSettings').then(module => ({ default: module.ModelSettings })));
export function ModelSettingsHost() {
  const open = settingsStore.use();
  const [visited, setVisited] = React.useState(false);
  React.useEffect(() => { if (open) setVisited(true); }, [open]);
  // Retain the existing settings/draft guard identity after its first visit.
  return open || visited ? <React.Suspense fallback={<Dialog open={open} onOpenChange={settingsStore.set} title="模型与 Key"><span role="status"><Spinner />正在载入模型设置…</span></Dialog>}>
    <Settings />
  </React.Suspense> : null;
}
