import * as React from 'react';
import { Banner, Button, Dialog, Input, Spinner } from '../../components/ui';
import { paletteStore, publicationSettingsStore, settingsStore, skillSettingsStore, shortcutHelpStore, backupSettingsStore, editorialStore } from '../../app/uiState';
import { accountStore, queryClient, rpc, useAccountQuery, useCurrentAccount } from '../../data/client';
import { siteForUrl, type Website } from '../../data/websites';
import { toast } from '../../components/toast';
import '../../styles/assets.css';

type BrowserState = { site?: Website; account_id?: string; url?: string; title?: string; loading?: boolean;
  openCount?: number; popupCount?: number; cancelled?: boolean; canBack?: boolean; canForward?: boolean; error?: string; download?: string };
type Bounds = { x: number; y: number; width: number; height: number };
type BrowserBridge = { browserShow: (params: { site: Website; bounds: Bounds }) => Promise<BrowserState>;
  browserHide: () => Promise<unknown>; browserBounds: (bounds: Bounds) => Promise<unknown>;
  browserCommand: (action: string, value?: string) => Promise<BrowserState>;
  onBrowserState: (callback: (state: BrowserState) => void) => () => void };
type Bookmark = { bookmark_id: string; url: string; title: string; is_default: boolean };
const SITE_LABEL: Record<Website, string> = { wechat: '微信公众号后台会话', tapnow: 'TapNow 会话', web: '通用网页会话' };
function normalizeAddress(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : 'https://' + value;
}
export function BrowserWorkspace({ site, pendingUrl, pendingNonce, onSite, onClose }: { site: Website; pendingUrl?: string; pendingNonce?: number;
  onSite: (site: Website, url?: string) => void; onClose: () => void }) {
  const account = useCurrentAccount(), palette = paletteStore.use(), settings = settingsStore.use(), publication = publicationSettingsStore.use();
  const help = shortcutHelpStore.use(), backup = backupSettingsStore.use(), editorial = editorialStore.use();
  const skills = skillSettingsStore.use();
  const [releaseAll, setReleaseAll] = React.useState(false), [releasing, setReleasing] = React.useState(false);
  const releasingRef = React.useRef(false), mounted = React.useRef(true);
  const externalSuspended = palette || settings || publication || help || backup || editorial || skills;
  const suspended = externalSuspended || releaseAll;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [region, setRegion] = React.useState<HTMLDivElement | null>(null);
  const [state, setState] = React.useState<BrowserState>({}), [address, setAddress] = React.useState('');
  const [error, setError] = React.useState<string | null>(null), [retry, setRetry] = React.useState(0);
  const addressEditing = React.useRef(false), [compact, setCompact] = React.useState(true);
  const bridge = window.ice as unknown as BrowserBridge;
  const bookmarks = useAccountQuery<Bookmark[]>('bookmarks.list', {}, { staleTime: 30_000 });
  const [manage, setManage] = React.useState(false);
  const navigated = React.useRef<number | undefined>(undefined);
  const refreshBookmarks = () => queryClient.invalidateQueries({ queryKey: ['ice', account, 'bookmarks.list'] });
  const bookmarkCall = async (method: string, params: Record<string, unknown>, done: string) => {
    try { await rpc(method, { account_id: account, ...params }); await refreshBookmarks(); toast.success({ title: done }); }
    catch (problem) { toast.error({ title: '收藏没有更新', detail: (problem as Error).message }); }
  };
  const go = (raw: string) => {
    const url = normalizeAddress(raw);
    if (!url) return;
    const target = siteForUrl(url);
    if (target !== site) onSite(target, url);
    else void command('navigate', url);
  };
  const available = ['browserShow', 'browserHide', 'browserBounds', 'browserCommand', 'onBrowserState'].every(key => typeof (bridge as unknown as Record<string, unknown>)?.[key] === 'function');
  React.useEffect(() => {
    if (!available || suspended) return;
    let active = true, frame = 0;
    const element = region;
    if (!element) return;
    const rectangle = () => {
      const box = element.getBoundingClientRect();
      return { x: Math.ceil(box.x), y: Math.ceil(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };
    };
    const receive = (next: BrowserState) => {
      if (!active || next.account_id && next.account_id !== account || next.site && next.site !== site) return;
      setState(next); if (!addressEditing.current && next.url) setAddress(next.url);
    };
    const off = bridge.onBrowserState(receive);
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (active) void bridge.browserBounds(rectangle()).catch(problem => { if (active) setError(problem.message); }); }); };
    setError(null); setState({ site, loading: true });
    void bridge.browserHide().then(() => active ? bridge.browserShow({ site, bounds: rectangle() }) : null)
      .then(next => {
        if (!next || !active) return;
        receive(next);
        // 从收藏/地址栏切换会话后，在新会话中打开目标地址（每次请求只导航一次）。
        if (pendingUrl && navigated.current !== pendingNonce) { navigated.current = pendingNonce; void bridge.browserCommand('navigate', pendingUrl).catch(problem => { if (active) setError(problem.message); }); }
      }).catch(problem => { if (active) setError(problem.message); });
    const observer = new ResizeObserver(update); observer.observe(element); window.addEventListener('resize', update);
    return () => { active = false; off(); observer.disconnect(); window.removeEventListener('resize', update); cancelAnimationFrame(frame); void bridge.browserHide().catch(() => undefined); };
    // Bridge identity is fixed by preload. A site/account or popup change reattaches safely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, account, suspended, available, retry, region, pendingNonce]);
  const command = async (action: string, value?: string) => {
    if (!available) return;
    setError(null);
    try { await bridge.browserCommand(action, value); }
    catch (problem) { setError((problem as Error).message); }
  };
  const closePages = async (all: boolean) => {
    if (!available || releasingRef.current) return;
    releasingRef.current = true; setReleasing(true); setError(null);
    const sourceAccount = account;
    const current = () => mounted.current && accountStore.get() === sourceAccount;
    try {
      const outcome = await bridge.browserCommand(all ? 'close-all' : 'close');
      if (!current()) return;
      setReleaseAll(false);
      if (outcome.cancelled) { setError('网页已切换，本次释放已取消，请核对当前页面。'); return; }
      onClose();
    } catch (problem) { if (current()) { setReleaseAll(false); setError((problem as Error).message); } }
    finally { releasingRef.current = false; if (current()) setReleasing(false); }
  };
  return <>
    <Dialog open={releaseAll && !externalSuspended} onOpenChange={open => { if (!releasing) setReleaseAll(open); }} title="释放全部网页"
      description="会关闭本公众号的全部站点和登录弹窗，并取消未完成的下载。请先保存网页内未完成的内容。" initialFocus="[data-cancel-release]"
      footer={<><Button data-cancel-release disabled={releasing} onClick={() => setReleaseAll(false)}>继续使用网页</Button>
        <Button variant="danger" loading={releasing} onClick={() => void closePages(true)}>确认释放全部网页</Button></>}>
      <p>当前保留 {state.openCount ?? 1} 个站点{state.popupCount ? `和 ${state.popupCount} 个弹窗` : ''}。登录信息、已保存的下载文件与本地文章均保留。</p>
    </Dialog>
    <Dialog open={!suspended} onOpenChange={open => { if (!open) onClose(); }} width={1800} className="ice-browser-dialog" title="网页"
    footer={<><span className="ice-asset-muted" style={{ flex: 1 }} role="status">{state.loading ? '网页正在加载…' : state.title || '网页在当前公众号独立登录'}</span>
      <Button disabled={!available || releasing} title="关闭当前网页并释放其内容占用；下次从站点首页打开，保留登录信息。请先保存网站内未完成的内容。"
        onClick={() => void closePages(false)}>关闭并释放网页</Button>
      <Button disabled={!available || releasing} onClick={() => setReleaseAll(true)}>释放全部网页{state.openCount ? `（${state.openCount}）` : ''}</Button>
      <Button disabled={releasing} title="收起面板后保留网页，方便继续操作" onClick={onClose}>返回文章</Button></>}>
    <div className="ice-asset-grid ice-browser-layout">
      <div className="ice-asset-row ice-bookmark-bar" role="toolbar" aria-label="本公众号的网页收藏">
        {(bookmarks.data ?? []).map(item => <Button key={item.bookmark_id} size="sm" variant={state.url?.startsWith(item.url) ? 'primary' : 'secondary'}
          title={item.url} onClick={() => go(item.url)}>{item.title}</Button>)}
        {bookmarks.error && <span className="ice-asset-muted">收藏读取失败</span>}
        <Button size="sm" variant="ghost" disabled={!state.url || state.url === 'about:blank'} onClick={() => state.url && void bookmarkCall('bookmarks.save', { url: state.url, title: (state.title || '').slice(0, 80) || undefined }, '已收藏此页')}>收藏此页</Button>
        <Button size="sm" variant="ghost" onClick={() => setManage(value => !value)}>{manage ? '完成' : '管理收藏'}</Button>
        <span style={{ flex: 1 }} />
        <span className="ice-asset-muted" title="登录信息按公众号和会话隔离，不会被其他公众号使用">{SITE_LABEL[site]}</span>
        <Button size="sm" variant="ghost" onClick={() => setCompact(value => !value)}>{compact ? '说明' : '收起说明'}</Button></div>
      {manage && <div className="ice-asset-row ice-bookmark-manage">
        {(bookmarks.data ?? []).map(item => <span key={item.bookmark_id} className="ice-bookmark-chip">{item.title}{item.is_default ? '（默认）' : ''}
          <button type="button" className="ice-link-btn" aria-label={'删除收藏 ' + item.title} onClick={() => void bookmarkCall('bookmarks.remove', { bookmark_id: item.bookmark_id }, '已删除收藏')}>删除</button></span>)}
        <Button size="sm" variant="ghost" onClick={() => void bookmarkCall('bookmarks.restore_defaults', {}, '已恢复默认收藏')}>恢复默认收藏</Button>
      </div>}
      {!compact && <p className="ice-asset-muted">收藏只属于当前公众号。微信公众号后台和 TapNow 各用独立登录会话，其余网页使用本公众号的通用网页会话；任何会话都不会与其他公众号共享 Cookie。外部网页无法访问本应用的文件或功能；无法内嵌的页面可“在系统浏览器打开”。</p>}
      <form className="ice-asset-row" onSubmit={event => { event.preventDefault(); addressEditing.current = false; go(address); }}>
        <Button type="button" disabled={!available || !state.canBack} onClick={() => void command('back')} aria-label="网页后退">←</Button>
        <Button type="button" disabled={!available || !state.canForward} onClick={() => void command('forward')} aria-label="网页前进">→</Button>
        <Button type="button" disabled={!available} onClick={() => void command(state.loading ? 'stop' : 'reload')}>{state.loading ? '停止加载' : '刷新网页'}</Button>
        <Button type="button" disabled={!available || site === 'web'} onClick={() => void command('home')}>站点首页</Button>
        <Input aria-label="内嵌网页地址" style={{ flex: '1 1 220px', minWidth: 120 }} value={address} onFocus={() => { addressEditing.current = true; }}
          onBlur={() => { addressEditing.current = false; }} onChange={event => setAddress(event.target.value)} placeholder="输入网址，例如 mp.weixin.qq.com" />
        <Button type="submit" disabled={!available}>前往</Button>
        <Button type="button" variant="ghost" disabled={!available || !state.url || state.url === 'about:blank'} title="用系统默认浏览器打开当前网页（不带本应用的登录状态）"
          onClick={() => void command('external')}>在系统浏览器打开</Button>
      </form>
      {(!available || error || state.error) && <Banner tone="warning" title="网页暂不可用">{!available ? '请在桌面程序中使用内嵌浏览器' : error || state.error}
        {available && <Button size="sm" onClick={() => setRetry(value => value + 1)}>重新连接网页</Button>}</Banner>}
      {state.download && <p role="status" className="ice-asset-muted">{state.download}</p>}
      <div ref={setRegion} className="ice-browser-region" aria-label="内嵌网页区域">{state.loading && <Spinner />}</div>
    </div>
  </Dialog></>;
}
