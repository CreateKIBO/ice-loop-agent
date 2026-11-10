import * as React from 'react';
import { Dialog, Spinner } from '../components/ui';
import { useCurrentAccount } from '../data/client';
import { skillSettingsStore } from './uiState';
const Settings = React.lazy(() => import('../features/skills/SkillSettings').then(module => ({ default: module.SkillSettings })));
export function SkillSettingsHost() {
  const open = skillSettingsStore.use(), account = useCurrentAccount(), previous = React.useRef(account);
  React.useEffect(() => { if (previous.current !== account) { previous.current = account; skillSettingsStore.set(false); } }, [account]);
  return open ? <React.Suspense fallback={<Dialog open onOpenChange={skillSettingsStore.set} title="写作技能"><span role="status"><Spinner />正在读取技能…</span></Dialog>}>
    <Settings key={account} />
  </React.Suspense> : null;
}
