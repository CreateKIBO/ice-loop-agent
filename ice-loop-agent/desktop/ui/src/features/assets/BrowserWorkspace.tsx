import * as React from 'react';
import { Banner, Button, Dialog, Input, Spinner } from '../../components/ui';
import { paletteStore, publicationSettingsStore, settingsStore } from '../../app/uiState';
import { useCurrentAccount } from '../../data/client';
import type { Website } from '../../data/websites';
import '../../styles/assets.css';

type BrowserState = { site?: Website; account_id?: string; url?: string; title?: string; loading?: boolean;
  canBack?: boolean; canForward?: boolean; error?: string; download?: string };
type Bounds = { x: number; y: number; width: number; height: number };
type BrowserBridge = { browserShow: (params: { site: Website; bounds: Bounds }) => Promise<BrowserState>;
  browserHide: () => Promise<unknown>; browserBounds: (bounds: Bounds) => Promise<unknown>;
  browserCommand: (action: string, value?: string) => Promise<BrowserState>;
  onBrowserState: (callback: (state: BrowserState) => void) => () => void };
export function BrowserWorkspace({ site, onSite, onClose }: { site: Website; onSite: (site: Website) => void; onClose: () => void }) {
  const account = useCurrentAccount(), palette = paletteStore.use(), settings = settingsStore.use(), publication = publicationSettingsStore.use();
  const suspended = palette || settings || publication;
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
  return <Dialog open={!suspended} onOpenChange={open => { if (!open) onClose(); }} width={1800} className="ice-browser-dialog" title="内嵌网页工作台"
    footer={<><span className="ice-asset-muted" style={{ flex: 1 }} role="status">{state.loading ? '网页正在加载…' : state.title || '网页在当前公众号独立登录'}</span>
      <Button disabled={!available} title="关闭当前网页并释放其内容占用；下次从站点首页打开，保留登录信息。请先保存网站内未完成的内容。"
        onClick={() => { if (available) void bridge.browserCommand('close').then(onClose).catch(problem => setError(problem.message)); }}>关闭并释放网页</Button>
      <Button title="收起面板后保留网页，方便继续操作" onClick={onClose}>返回文章</Button></>}>
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
  </Dialog>;
}
