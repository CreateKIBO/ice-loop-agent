import * as React from 'react';
import { Banner, Button, Dialog, ErrorPanel, Input, Spinner } from '../../components/ui';
import { toast } from '../../components/toast';
import { dirtyStore, queryClient, registerDirtyFlush, rpc, useAccountQuery, useCurrentAccount } from '../../data/client';
import { ImageThumbnail, ImageViewer, type ImageTarget } from './ImageViewer';
import { kindLabel, promptParams, resourcePage, usableRunKeys, type AssetCandidate, type AssetDetail, type FigureSlot, type ResourceRow } from './assetModel';
import { PromptPanel } from './PromptPanel';
import '../../styles/assets.css';

export function AssetWorkspace({ jobId, figureNo, onClose }: { jobId: string; figureNo?: number; onClose: () => void }) {
  const account = useCurrentAccount();
  const query = useAccountQuery<AssetDetail>('jobs.get', { job_id: jobId }, { staleTime: 0, refetchOnMount: 'always' });
  const [selected, setSelected] = React.useState<number | undefined>(figureNo);
  const [busy, setBusy] = React.useState(false), busyRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false), dirtyRef = React.useRef(false);
  const [confirmClose, setConfirmClose] = React.useState(false);
  const [viewer, setViewer] = React.useState<ImageTarget | null>(null);
  const dirtyKey = `assets:${account}:${jobId}`;
  const markDirty = React.useCallback((value: boolean) => {
    dirtyRef.current = value; setDirty(value);
    if (value) dirtyStore.markDirty(dirtyKey); else dirtyStore.markClean(dirtyKey);
  }, [dirtyKey]);
  React.useEffect(() => {
    const off = registerDirtyFlush(dirtyKey, () => { if (dirtyRef.current) throw Error('配图提示词有未保存修改，请先保存或放弃再切换'); });
    return () => { off(); dirtyStore.markClean(dirtyKey); };
  }, [dirtyKey]);
  const data = query.data?.article.spec.account_id === account ? query.data : undefined;
  const slot = data?.slots.find(row => row.figure_no === selected) ?? data?.slots[0];
  const locked = busy || Boolean(data?.job.lease) || data?.pending_approval?.scope === 'asset_plan';
  const mutate = async (action: () => Promise<unknown>, title: string) => {
    if (busyRef.current || locked) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const changed = await action();
      if (changed === null) return;
      markDirty(false);
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: ['ice', account, 'articles.delivery_snapshot'] }),
        queryClient.invalidateQueries({ queryKey: ['ice', account, 'resources.list'] }),
        queryClient.invalidateQueries({ queryKey: ['ice', account, 'downloads.list'] }),
      ]);
      toast.success({ title });
    } catch (problem) { setError((problem as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const close = () => { if (busyRef.current) return; if (dirtyRef.current) setConfirmClose(true); else onClose(); };
  const review = (candidate: AssetCandidate, decision: string, note = '') => mutate(() => rpc('assets.review', {
    account_id: account, job_id: jobId, candidate_id: candidate.candidate_id, decision, note,
    content_hash: candidate.content_hash, slot_hash: slot!.content_hash,
  }), decision === 'accepted' ? '已审核并采纳图片' : '已否决图片');
  return <>
    <Dialog open onOpenChange={open => { if (!open) close(); }} width={1040} title="文章配图工作台"
      description="按图位准备真实截图或生图，审阅候选后采纳。所有操作属于当前公众号与文章。"
      footer={confirmClose ? <><span className="ice-asset-muted" style={{ flex: 1 }}>提示词尚未保存</span><Button onClick={() => setConfirmClose(false)}>继续编辑提示词</Button>
        <Button variant="danger" onClick={() => { markDirty(false); onClose(); }}>放弃提示词并关闭</Button></> : <>
        <span className="ice-asset-muted" style={{ flex: 1 }} role="status">{busy ? '正在处理图片…' : dirty ? '提示词尚未保存' : data ? `${data.slots.filter(row => row.valid).length}/${data.slots.length} 图位已有有效图片` : ''}</span>
        <Button disabled={busy || dirty} onClick={() => { setError(null); void query.refetch(); }}>刷新配图</Button><Button disabled={busy} onClick={close}>关闭配图工作台</Button></>}>
      {query.isLoading && <div className="ice-asset-loading"><Spinner />正在读取图位…</div>}
      {query.error && <ErrorPanel title="图位读取失败" detail={query.error.message} onRetry={() => void query.refetch()} />}
      {error && <Banner tone="danger" title="配图操作未完成">{error}。当前内容保留，可刷新核对后重试。</Banner>}
      {data && <div className="ice-asset-grid">
        <div className="ice-asset-row"><strong>{data.article.final_title || data.article.topic}</strong><span className="ice-badge">{data.article.series}/{data.article.episode}</span></div>
        {locked && !busy && <Banner tone="warning" title="暂时不能修改配图">请先等待任务停止，并完成配图计划审阅。</Banner>}
        <nav className="ice-asset-tabs" aria-label="选择文章图位">{data.slots.map(row => <Button key={row.slot_id} aria-pressed={slot?.slot_id === row.slot_id}
          disabled={busy || (dirty && row.slot_id !== slot?.slot_id)} variant={row.slot_id === slot?.slot_id ? 'primary' : 'secondary'} onClick={() => { setSelected(row.figure_no); setError(null); }}>
          图{row.figure_no} · {kindLabel(row.kind)} · {row.valid ? '已采纳' : '待配图'}</Button>)}</nav>
        {!slot && <p className="ice-asset-muted">当前文章尚无图位；完成并确认配图计划后再打开。</p>}
        {slot && <div className="ice-asset-grid" key={slot.slot_id + ':' + slot.content_hash}>
          <h3>图{slot.figure_no}：{slot.caption}</h3>{slot.position && <p className="ice-asset-muted">位置：{slot.position}</p>}
          <div className="ice-asset-row">
            <Button disabled={locked || dirty} onClick={() => void mutate(async () => {
              const pick = window.ice?.importImage;
              if (typeof pick !== 'function') throw Error('请使用桌面程序选择图片');
              const result = await (pick as (job: string, figure: number) => Promise<unknown>)(jobId, slot.figure_no);
              return result;
            }, '图片已导入、归档并采纳')}>导入图片并采纳</Button>
          </div>
          {slot.kind === 'body_real' ? <CapturePanel data={data} slot={slot} disabled={locked || dirty} onCapture={keys => mutate(async () => {
            const capture = window.ice?.captureRun;
            if (typeof capture !== 'function') throw Error('截图需要桌面程序');
            await (capture as (job: string, figure: number, keys: string[]) => Promise<unknown>)(jobId, slot.figure_no, keys);
          }, '真实运行截图已生成并归档')} /> : <PromptPanel data={data} slot={slot} disabled={locked} onDirty={markDirty}
            onSave={prompt => mutate(() => rpc('prompts.save', { account_id: account, ...promptParams(data, slot), prompt }), '提示词已保存，已有图片保留')} />}
          <ResourcePicker account={account} slot={slot} disabled={locked || dirty} onOpen={setViewer} onUse={resource => mutate(() => rpc('resources.use', {
            account_id: account, job_id: jobId, figure_no: slot.figure_no, slot_hash: slot.content_hash,
            resource_id: resource.resource_id, content_hash: resource.content_hash,
          }), '资源已复制到图位并采纳')} />
          <CandidateList account={account} jobId={jobId} slot={slot} disabled={locked || dirty} onOpen={setViewer} onReview={review} />
        </div>}
      </div>}
    </Dialog>
    {viewer && <ImageViewer target={viewer} onClose={() => setViewer(null)} />}
  </>;
}

function CapturePanel({ data, slot, disabled, onCapture }: { data: AssetDetail; slot: FigureSlot; disabled: boolean; onCapture: (keys: string[]) => Promise<void> }) {
  const keys = usableRunKeys(data);
  const [selected, setSelected] = React.useState<string[]>(() => keys.length === 1 ? keys : []);
  return <section className="ice-asset-card" aria-label="真实运行截图">
    <h4>选择要呈现的真实运行</h4><p className="ice-asset-muted">请选择与图位内容对应的程序。截图只使用已执行并通过校验的源码和输出，最多六段；不要用生图替代程序结果。</p>
    {!keys.length && <p>暂无可用运行证据，请先完成代码验证。</p>}
    {keys.map(key => <label key={key} className="ice-asset-row"><input type="checkbox" checked={selected.includes(key)} disabled={disabled}
      onChange={event => setSelected(old => event.target.checked ? [...old, key] : old.filter(value => value !== key))} />
      {data.runs[key].filename} · {data.runs[key].verdict === 'expected_failure_ok' ? '预期报错素材' : '运行通过'}</label>)}
    <Button variant="primary" disabled={disabled || !selected.length || selected.length > 6} onClick={() => void onCapture(selected)}>生成图{slot.figure_no}真实截图</Button>
  </section>;
}

function ResourcePicker({ account, slot, disabled, onUse, onOpen }: { account: string; slot: FigureSlot; disabled: boolean;
  onUse: (row: ResourceRow) => Promise<void>; onOpen: (target: ImageTarget) => void }) {
  const [open, setOpen] = React.useState(false), [search, setSearch] = React.useState(''), [page, setPage] = React.useState(0);
  const list = useAccountQuery<ResourceRow[]>('resources.list', {}, { enabled: open, staleTime: 0, gcTime: 10000 });
  const result = resourcePage(list.data ?? [], search, slot.kind, page);
  return <section className="ice-asset-card"><div className="ice-asset-row"><h4 style={{ flex: 1 }}>复用当前公众号资源</h4>
    <Button aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? '收起资源库' : '从资源库选图'}</Button></div>
    {open && <>
      <Input aria-label="搜索配图资源" placeholder="搜索名称、说明或标签" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />
      <p className="ice-asset-muted">共 {result.total} 张，按图位用途优先列出。采用前核对图意与来源，旧截图不能替代本文代码的执行证据。</p>
      {list.error && <ErrorPanel title="资源读取失败" detail={list.error.message} onRetry={() => void list.refetch()} />}
      {list.isLoading && <Spinner />}
      <div className="ice-asset-cards">{result.rows.map(row => <article className="ice-asset-card" key={row.resource_id}>
        <ImageThumbnail target={{ kind: 'resource', accountId: account, resourceId: row.resource_id, caption: row.title }} onOpen={onOpen} />
        <strong>{row.title}</strong><span className="ice-asset-muted">{row.width} × {row.height}</span>
        <Button disabled={disabled} onClick={() => void onUse(row)}>采用此资源</Button>
      </article>)}</div>
      {!list.isLoading && !result.rows.length && <p>没有匹配资源，可先导入图片或调整搜索词。</p>}
      <div className="ice-asset-row"><Button disabled={result.current === 0} onClick={() => setPage(result.current - 1)}>上一页资源</Button>
        <span>{result.current + 1}/{result.pages}</span><Button disabled={result.current + 1 >= result.pages} onClick={() => setPage(result.current + 1)}>下一页资源</Button></div>
    </>}
  </section>;
}

function CandidateList({ account, jobId, slot, disabled, onReview, onOpen }: { account: string; jobId: string; slot: FigureSlot; disabled: boolean;
  onReview: (row: AssetCandidate, decision: string, note?: string) => Promise<void>; onOpen: (target: ImageTarget) => void }) {
  const [limit, setLimit] = React.useState(6);
  return <section className="ice-asset-grid"><h4>图位候选（{slot.candidates.length}）</h4>
    {!slot.candidates.length && <p className="ice-asset-muted">尚无候选。可截图、导入生图结果，或从资源库选择。</p>}
    <div className="ice-asset-cards">{[...slot.candidates].sort((a,b) => Number(b.candidate_id===slot.selected_candidate)-Number(a.candidate_id===slot.selected_candidate)).slice(0, limit).map(row => <CandidateCard key={row.candidate_id} row={row} slot={slot} disabled={disabled}
      target={{ kind: 'candidate', accountId: account, jobId, candidateId: row.candidate_id, caption: `图${slot.figure_no}：${slot.caption}` }} onOpen={onOpen} onReview={onReview} />)}</div>
    {slot.candidates.length > limit && <Button onClick={() => setLimit(value => value + 6)}>显示更多候选</Button>}
  </section>;
}
function CandidateCard({ row, slot, disabled, target, onReview, onOpen }: { row: AssetCandidate; slot: FigureSlot; disabled: boolean; target: ImageTarget;
  onReview: (row: AssetCandidate, decision: string, note?: string) => Promise<void>; onOpen: (target: ImageTarget) => void }) {
  const [reject, setReject] = React.useState(false), [note, setNote] = React.useState('');
  const selected = slot.selected_candidate === row.candidate_id;
  return <article className="ice-asset-card" data-candidate-id={row.candidate_id} data-selected={selected}>
    <ImageThumbnail target={target} onOpen={onOpen} />
    <div className="ice-asset-row"><span className="ice-badge">{selected ? '当前采用' : ({ accepted: '已审核', rejected: '已否决', pending: '待审核' } as Record<string, string>)[row.review_status] ?? row.review_status}</span>
      <span className="ice-asset-muted">{row.source === 'run_capture' ? '真实运行截图' : '导入图片'}</span></div>
    {reject ? <><textarea aria-label="否决图片原因" rows={2} value={note} maxLength={1000} disabled={disabled} onChange={event => setNote(event.target.value)} placeholder="说明内容、来源或风格的问题" />
      <Button variant="danger" disabled={disabled || !note.trim()} onClick={() => void onReview(row, 'rejected', note)}>确认否决图片</Button><Button onClick={() => setReject(false)}>返回图片候选</Button></> : <div className="ice-asset-row">
      <Button disabled={disabled || selected} onClick={() => void onReview(row, 'accepted')}>审核并采纳</Button>
      <Button variant="ghost" disabled={disabled} onClick={() => setReject(true)}>否决图片</Button></div>}
  </article>;
}
