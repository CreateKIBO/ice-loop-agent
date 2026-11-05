import * as React from 'react';
import { useCurrentAccount } from '../data/client';
import { WEBSITE_EVENT, type Website } from '../data/websites';
const BrowserWorkspace = React.lazy(() => import('../features/assets/BrowserWorkspace').then(module => ({ default: module.BrowserWorkspace })));
const SITES: readonly Website[] = ['tapnow', 'wechat', 'web'];
type Target = { site: Website; url?: string; nonce: number };
export function BrowserHost() {
  const [target, setTarget] = React.useState<Target | null>(null);
  const account = useCurrentAccount();
  React.useEffect(() => { setTarget(null); }, [account]);
  React.useEffect(() => {
    // 兼容旧调用（字符串站点）与 v3 调用（{site,url}）；未知站点忽略。
    const show = (value: unknown) => {
      const detail = typeof value === 'string' ? { site: value } : value as { site?: unknown; url?: unknown } | null;
      const site = detail?.site;
      if (typeof site !== 'string' || !SITES.includes(site as Website)) return;
      const url = typeof detail?.url === 'string' && detail.url.startsWith('https://') ? detail.url : undefined;
      setTarget({ site: site as Website, url, nonce: Date.now() });
    };
    const listener = (event: Event) => show((event as CustomEvent).detail);
    window.addEventListener(WEBSITE_EVENT, listener);
    const subscribe = window.ice?.onBrowserRoute;
    const off = typeof subscribe === 'function' ? (subscribe as (callback: (value: string) => void) => () => void)(show) : undefined;
    return () => { window.removeEventListener(WEBSITE_EVENT, listener); off?.(); };
  }, []);
  return target ? <React.Suspense fallback={null}><BrowserWorkspace key={account} site={target.site} pendingUrl={target.url} pendingNonce={target.nonce}
    onSite={(site, url) => setTarget({ site, url, nonce: Date.now() })} onClose={() => setTarget(null)} /></React.Suspense> : null;
}
