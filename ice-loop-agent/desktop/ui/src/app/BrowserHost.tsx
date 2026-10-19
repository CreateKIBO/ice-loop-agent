import * as React from 'react';
import { useCurrentAccount } from '../data/client';
import { WEBSITE_EVENT, type Website } from '../data/websites';
const BrowserWorkspace = React.lazy(() => import('../features/assets/BrowserWorkspace').then(module => ({ default: module.BrowserWorkspace })));
export function BrowserHost() {
  const [site, setSite] = React.useState<Website | null>(null);
  const account = useCurrentAccount();
  React.useEffect(() => { setSite(null); }, [account]);
  React.useEffect(() => {
    const show = (value: unknown) => { if (value === 'tapnow' || value === 'wechat') setSite(value); };
    const listener = (event: Event) => show((event as CustomEvent).detail);
    window.addEventListener(WEBSITE_EVENT, listener);
    const subscribe = window.ice?.onBrowserRoute;
    const off = typeof subscribe === 'function' ? (subscribe as (callback: (value: string) => void) => () => void)(show) : undefined;
    return () => { window.removeEventListener(WEBSITE_EVENT, listener); off?.(); };
  }, []);
  return site ? <React.Suspense fallback={null}><BrowserWorkspace key={account} site={site} onSite={setSite} onClose={() => setSite(null)} /></React.Suspense> : null;
}
