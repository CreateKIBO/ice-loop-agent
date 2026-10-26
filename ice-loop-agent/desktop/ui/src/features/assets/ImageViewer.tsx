import * as React from 'react';
import { Button, Dialog, ErrorPanel, Spinner } from '../../components/ui';
import { rpc, useCurrentAccount } from '../../data/client';
import { boundedZoom, fitImage, imageLease } from './imageLease';
import { imageQueue } from './imageQueue';
import '../../styles/assets.css';

export type ImageTarget = { accountId: string; caption: string } & (
  { kind: 'candidate'; jobId: string; candidateId: string } | { kind: 'resource'; resourceId: string }
);
export function previewRequest(target: ImageTarget, original = false) {
  return target.kind === 'candidate'
    ? { method: 'assets.preview', params: { account_id: target.accountId, job_id: target.jobId, candidate_id: target.candidateId, original } }
    : { method: 'resources.preview', params: { account_id: target.accountId, resource_id: target.resourceId, original } };
}
function dataUrl(result: unknown): string {
  const value = typeof result === 'string' ? result : (result as { data_url?: unknown })?.data_url;
  if (typeof value !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/.test(value)) throw Error('图片预览未返回有效数据');
  return value;
}

export function ImageThumbnail({ target, onOpen }: { target: ImageTarget; onOpen: (target: ImageTarget) => void }) {
  const request = previewRequest(target);
  const account = useCurrentAccount();
  const [source, setSource] = React.useState(''), [loading, setLoading] = React.useState(false);
  const key = JSON.stringify(request);
  React.useEffect(() => {
    const control = new AbortController(); let lease: ReturnType<typeof imageLease> | undefined;
    setSource(''); setLoading(account === target.accountId);
    if (account !== target.accountId) return;
    void imageQueue.run(() => rpc<unknown>(request.method, request.params), control.signal).then(result => {
      if (control.signal.aborted) return;
      lease = imageLease(dataUrl(result)); setSource(lease.url); setLoading(false);
    }).catch(() => { if (!control.signal.aborted) setLoading(false); });
    return () => { control.abort(); lease?.release(); };
    // Every mounted thumbnail owns its URL; no large response stays in Query caches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, account]);
  return <button type="button" className="ice-asset-thumb" aria-label={`查看原图：${target.caption}`} onClick={() => onOpen(target)}>
    {source ? <img src={source} alt={target.caption} loading="lazy" /> : <span>{loading ? '读取预览…' : '点击查看原图'}</span>}
  </button>;
}

export function ImageViewer({ target, onClose }: { target: ImageTarget; onClose: () => void }) {
  const account = useCurrentAccount();
  const [image, setImage] = React.useState<{ url: string; width: number; height: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [mode, setMode] = React.useState<'fit' | 'zoom'>('fit');
  const [zoom, setZoom] = React.useState(1);
  const [area, setArea] = React.useState({ width: 960, height: 480 });
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null);
  const drag = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const request = previewRequest(target, true), key = JSON.stringify(request);
  React.useEffect(() => {
    let active = true, lease: { url: string; release: () => void } | undefined;
    const control = new AbortController();
    setImage(null); setError(null); setMode('fit');
    if (account !== target.accountId) { setError('公众号已切换，请重新打开图片'); return; }
    const originalBridge = window.ice as unknown as {
      openOriginalImage?: (params: Record<string, unknown>) => Promise<{ token: string; url: string }>;
      releaseOriginalImage?: (token: string) => Promise<unknown>;
    };
    void imageQueue.run(async () => {
      if (originalBridge.openOriginalImage && originalBridge.releaseOriginalImage) {
        const params = target.kind === 'candidate'
          ? { kind: 'candidate', account_id: target.accountId, job_id: target.jobId, candidate_id: target.candidateId }
          : { kind: 'resource', account_id: target.accountId, resource_id: target.resourceId };
        const opened = await originalBridge.openOriginalImage(params);
        try {
          const response = await fetch(opened.url, { signal: control.signal, cache: 'no-store' });
          if (!response.ok) throw Error('原图授权已失效，请重新打开图片');
          // Binary Blob avoids base64/JSON copies and retains explicit revocation semantics.
          lease = imageLease(await response.blob());
        } finally {
          await originalBridge.releaseOriginalImage(opened.token).catch(() => undefined);
        }
      } else {
        lease = imageLease(dataUrl(await rpc<unknown>(request.method, request.params)));
      }
      // A reply after unmount must release its main-process capability too.
      if (!active) lease.release();
      return lease;
    }, control.signal, true).then(opened => {
      if (active) setImage({ url: opened.url, width: 0, height: 0 });
    }).catch(problem => { if (active) setError((problem as Error).message); });
    return () => { active = false; control.abort(); lease?.release(); };
    // Only semantic identity changes reload the large original; no Query entry retains it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, account, retry]);
  React.useEffect(() => {
    const node = viewport;
    if (!node) return;
    const update = () => setArea({ width: node.clientWidth, height: node.clientHeight });
    update(); const observer = new ResizeObserver(update); observer.observe(node);
    return () => observer.disconnect();
  }, [viewport]);
  const fit = image ? fitImage(image, area) : 1, scale = mode === 'fit' ? fit : zoom;
  const changeZoom = (value: number) => { setZoom(boundedZoom(value)); setMode('zoom'); };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }} width={1200}
    title="图片原图" description={`${target.caption}。滚轮滚动，按住图片拖动查看；关闭后释放本次原图资源。`}
    footer={<>
      <span className="ice-asset-muted" role="status" style={{ flex: 1 }}>{image?.width ? `${image.width} × ${image.height} · ${Math.round(scale * 100)}%` : '按需读取原图'}</span>
      <Button disabled={!image?.width} onClick={() => changeZoom(scale / 1.25)} aria-label="缩小图片">−</Button>
      <Button disabled={!image?.width} onClick={() => changeZoom(scale * 1.25)} aria-label="放大图片">＋</Button>
      <Button disabled={!image?.width} onClick={() => changeZoom(1)}>原始大小 100%</Button>
      <Button disabled={!image?.width} onClick={() => setMode('fit')}>适应窗口</Button>
      <Button onClick={onClose}>关闭原图</Button>
    </>}>
    {error && <ErrorPanel title="原图读取失败" detail={error} onRetry={() => setRetry(value => value + 1)} />}
    <div ref={setViewport} className="ice-image-viewport" data-fit={mode === 'fit'} tabIndex={0} aria-label="可滚动的原图区域"
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(scale * 1.25); }
        else if (event.key === '-') { event.preventDefault(); changeZoom(scale / 1.25); }
        else if (event.key === '0') { event.preventDefault(); setMode('fit'); }
      }} onPointerDown={event => {
        if (event.button !== 0 || !image) return;
        const node = event.currentTarget; node.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
      }} onPointerMove={event => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
        event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {!image && !error && <div className="ice-asset-loading"><Spinner />正在读取原图…</div>}
      {image && <div className="ice-image-canvas" style={{ width: mode === 'fit' ? '100%' : image.width ? Math.max(area.width, image.width * scale + 24) : '100%',
        height: mode === 'fit' ? '100%' : image.height ? Math.max(area.height, image.height * scale + 24) : '100%' }}>
        <img src={image.url} alt={target.caption} draggable={false} style={{ width: image.width ? image.width * scale : undefined,
          height: image.height ? image.height * scale : undefined, maxWidth: mode === 'fit' ? '100%' : undefined,
          maxHeight: mode === 'fit' ? '100%' : undefined }} onLoad={event => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            setImage(previous => previous?.url === image.url ? { ...previous, width, height } : previous);
          }} onError={() => setError('原图无法显示，请重试；仍失败时核对图片文件')} />
      </div>}
    </div>
  </Dialog>;
}
