import * as React from 'react';
import { Banner, Button, Dialog, Input, Spinner } from '../../components/ui';
import { paletteStore, publicationSettingsStore, settingsStore, shortcutHelpStore, backupSettingsStore, editorialStore } from '../../app/uiState';
import { accountStore, useCurrentAccount } from '../../data/client';
import type { Website } from '../../data/websites';
import '../../styles/assets.css';

type BrowserState = { site?: Website; account_id?: string; url?: string; title?: string; loading?: boolean;
  openCount?: number; popupCount?: number; cancelled?: boolean; canBack?: boolean; canForward?: boolean; error?: string; download?: string };
type Bounds = { x: number; y: number; width: number; height: number };
type BrowserBridge = { browserShow: (params: { site: Website; bounds: Bounds }) => Promise<BrowserState>;
  browserHide: () => Promise<unknown>; browserBounds: (bounds: Bounds) => Promise<unknown>;
  browserCommand: (action: string, value?: string) => Promise<BrowserState>;
  onBrowserState: (callback: (state: BrowserState) => void) => () => void };
export function BrowserWorkspace({ site, onSite, onClose }: { site: Website; onSite: (site: Website) => void; onClose: () => void }) {
  const account = useCurrentAccount(), palette = paletteStore.use(), settings = settingsStore.use(), publication = publicationSettingsStore.use();
  const help = shortcutHelpStore.use(), backup = backupSettingsStore.use(), editorial = editorialStore.use();
  const [releaseAll, setReleaseAll] = React.useState(false), [releasing, setReleasing] = React.useState(false);
  const releasingRef = React.useRef(false), mounted = React.useRef(true);
  const externalSuspended = palette || settings || publication || help || backup || editorial;
  const suspended = externalSuspended || releaseAll;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [region, setRegion] = React.useState<HTMLDivElement | null>(null);
  const [state, setState] = React.useState<BrowserState>({}), [address, setAddress] = React.useState('');
  const [error, setError] = React.useState<string | null>(null), [retry, setRetry] = React.useState(0);
  const addressEditing = React.useRef(false), [compact, setCompact] = React.useState(true);
  const bridge = window.ice as unknown as BrowserBridge;
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
      .then(next => { if (next && active) receive(next); }).catch(problem => { if (active) setError(problem.message); });
    const observer = new ResizeObserver(update); observer.observe(element); window.addEventListener('resize', update);
    return () => { active = false; off(); observer.disconnect(); window.removeEventListener('resize', update); cancelAnimationFrame(frame); void bridge.browserHide().catch(() => undefined); };
    // Bridge identity is fixed by preload. A site/account or popup change reattaches safely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, account, suspended, available, retry, region]);
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
    <Dialog open={!suspended} onOpenChange={open => { if (!open) onClose(); }} width={1800} className="ice-browser-dialog" title="内嵌网页工作台"
    footer={<><span className="ice-asset-muted" style={{ flex: 1 }} role="status">{state.loading ? '网页正在加载…' : state.title || '网页在当前公众号独立登录'}</span>
      <Button disabled={!available || releasing} title="关闭当前网页并释放其内容占用；下次从站点首页打开，保留登录信息。请先保存网站内未完成的内容。"
        onClick={() => void closePages(false)}>关闭并释放网页</Button>
      <Button disabled={!available || releasing} onClick={() => setReleaseAll(true)}>释放全部网页{state.openCount ? `（${state.openCount}）` : ''}</Button>
      <Button disabled={releasing} title="收起面板后保留网页，方便继续操作" onClick={onClose}>返回文章</Button></>}>
    <div className="ice-asset-grid ice-browser-layout">
      <div className="ice-asset-row"><Button aria-pressed={site === 'tapnow'} variant={site === 'tapnow' ? 'primary' : 'secondary'} onClick={() => onSite('tapnow')}>TapNow 生图</Button>
        <Button aria-pressed={site === 'wechat'} variant={site === 'wechat' ? 'primary' : 'secondary'} onClick={() => onSite('wechat')}>微信公众号后台</Button>
        <Button variant="ghost" onClick={() => setCompact(value => !value)}>{compact ? '展开操作说明' : '收起操作说明'}</Button></div>
      {!compact && <p className="ice-asset-muted">TapNow：上传品牌参考图、粘贴提示词、生成后下载；返回文章后在待归档箱选择图位。公众号：导入文本和图片、手机预览后手动发布。本站网页使用当前公众号独立会话。</p>}
      <form className="ice-asset-row" onSubmit={event => { event.preventDefault(); addressEditing.current = false; void command('navigate', address); }}>
        <Button type="button" disabled={!available || !state.canBack} onClick={() => void command('back')} aria-label="网页后退">←</Button>
        <Button type="button" disabled={!available || !state.canForward} onClick={() => void command('forward')} aria-label="网页前进">→</Button>
        <Button type="button" disabled={!available} onClick={() => void command(state.loading ? 'stop' : 'reload')}>{state.loading ? '停止加载' : '刷新网页'}</Button>
        <Button type="button" disabled={!available} onClick={() => void command('home')}>站点首页</Button>
        <Input aria-label="内嵌网页地址" style={{ flex: '1 1 220px', minWidth: 120 }} value={address} onFocus={() => { addressEditing.current = true; }}
          onBlur={() => { addressEditing.current = false; }} onChange={event => setAddress(event.target.value)} placeholder="https://app.tapnow.media/home" />
        <Button type="submit" disabled={!available}>前往网页</Button>
      </form>
      {(!available || error || state.error) && <Banner tone="warning" title="网页暂不可用">{!available ? '请在桌面程序中使用内嵌浏览器' : error || state.error}
        {available && <Button size="sm" onClick={() => setRetry(value => value + 1)}>重新连接网页</Button>}</Banner>}
      {state.download && <p role="status" className="ice-asset-muted">{state.download}</p>}
      <div ref={setRegion} className="ice-browser-region" aria-label="内嵌网页区域">{state.loading && <Spinner />}</div>
    </div>
  </Dialog></>;
}
