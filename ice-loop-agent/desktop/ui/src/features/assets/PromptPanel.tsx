import * as React from 'react';
import { motion } from 'motion/react';
import { Button, Input, Spinner } from '../../components/ui';
import { useActivityReducedMotion } from '../../components/ActivityRail';
import { ErrorNote } from '../../components/ErrorNote';
import { CopyButton } from '../../components/CopyButton';
import { settingsStore } from '../../app/uiState';
import { queryClient, rpc, useAccountQuery, useCurrentAccount } from '../../data/client';
import { openWebsite } from '../../data/websites';
import { ImageThumbnail, ImageViewer, type ImageTarget } from './ImageViewer';
import { promptParams, slotPrompt, type AssetDetail, type FigureSlot } from './assetModel';

type Reference = { image: number; role: string; filename: string; title: string; resource_id: string };
type Budget = { used: number; limit: number; remaining: number; limits_hash: string };
export function PromptPanel({ data, slot, disabled, onDirty, onSave }: { data: AssetDetail; slot: FigureSlot; disabled: boolean;
  onDirty: (value: boolean) => void; onSave: (value: string) => Promise<void> }) {
  const account = useCurrentAccount(), original = slotPrompt(data, slot), params = promptParams(data, slot);
  const [text, setText] = React.useState(original), [candidate, setCandidate] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false), busyRef = React.useRef(false), edits = React.useRef(0);
  const [error, setError] = React.useState<unknown>(null), [viewer, setViewer] = React.useState<ImageTarget | null>(null);
  const [referencesOpen, setReferencesOpen] = React.useState(false); // 批D：参考区默认收起，折叠时卸载缩略图（租约走既有释放链）
  const [editingBudget, setEditingBudget] = React.useState<Budget | null>(null), [limit, setLimit] = React.useState(''), [budgetBusy, setBudgetBusy] = React.useState(false);
  const [budgetError, setBudgetError] = React.useState<unknown>(null);
  const [budgetSaved, setBudgetSaved] = React.useState(false);
  const panelRef = React.useRef<HTMLElement>(null), budgetFormRef = React.useRef<HTMLDivElement>(null);
  const limitRef = React.useRef<HTMLInputElement>(null), returnBudgetFocus = React.useRef(false);
  const reduced = useActivityReducedMotion();
  const mounted = React.useRef(true);
  const references = useAccountQuery<{ references: Reference[] }>('prompts.references', params, { enabled: !disabled, staleTime: 0, gcTime: 10000 });
  const budget = useAccountQuery<{ job: Budget }>('budgets.get', { job_id: data.job.job_id });
  React.useLayoutEffect(() => { if (editingBudget) limitRef.current?.focus(); }, [editingBudget]);
  React.useLayoutEffect(() => {
    if (editingBudget || budgetBusy || !returnBudgetFocus.current) return;
    returnBudgetFocus.current = false;
    // Radix may put focus on the dialog itself when a focused control becomes
    // disabled/removed. Preserve that fallback, but never replace a live field.
    const active = document.activeElement, dialog = panelRef.current?.closest('[role="dialog"]');
    if (active === document.body || active === dialog) panelRef.current?.querySelector<HTMLButtonElement>('[data-budget-entry]')?.focus({ preventScroll: true });
  }, [editingBudget, budgetBusy]);
  const closeBudget = () => {
    const active = document.activeElement, dialog = panelRef.current?.closest('[role="dialog"]');
    returnBudgetFocus.current = active === document.body || Boolean(budgetFormRef.current?.contains(active))
      || (returnBudgetFocus.current && active === dialog);
    setEditingBudget(null);
  };
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; onDirty(false); }; }, [onDirty]);
  const edit = (value: string) => { edits.current++; setText(value); onDirty(value !== original); };
  const generate = async () => {
    if (busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setError(null);
    const version = edits.current;
    try {
      const result = await rpc<{ prompt: string }>('prompts.generate', { account_id: account, ...params });
      if (!mounted.current) return;
      if (edits.current !== version) setCandidate(result.prompt); else edit(result.prompt);
    } catch (problem) { if (mounted.current) setError(problem); }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); void budget.refetch(); } }
  };
  const saveBudget = async () => {
    if (!editingBudget || busyRef.current || disabled) return;
    const maximum = Number(limit);
    if (!/^\d+$/.test(limit) || !Number.isInteger(maximum) || maximum < Math.max(1, editingBudget.used) || maximum > 100) {
      setBudgetError(`本篇上限需为 ${Math.max(1, editingBudget.used)}–100 的整数，不能低于已用次数`); return;
    }
    returnBudgetFocus.current = Boolean(budgetFormRef.current?.contains(document.activeElement));
    busyRef.current = true; setBudgetBusy(true); setBudgetError(null);
    try {
      const saved = await rpc<{ job: Budget }>('budgets.save', { account_id: account, job_id: data.job.job_id, scope: 'job', limit: maximum, limits_hash: editingBudget.limits_hash });
      if (mounted.current) {
        // This is a confirmed service receipt, including the new limits_hash.
        // A failed follow-up read must retain this version, not the old cache.
        queryClient.setQueryData(['ice', account, 'budgets.get', { job_id: data.job.job_id }], saved);
        setBudgetSaved(true); closeBudget();
        await budget.refetch();
      }
    } catch (problem) { if (mounted.current) setBudgetError(problem); }
    finally { busyRef.current = false; if (mounted.current) setBudgetBusy(false); }
  };
  return <section ref={panelRef} className="ice-asset-card" aria-label="生图提示词">
    <h4>提示词与品牌参考</h4><p className="ice-asset-muted">参考图需要在 TapNow 按顺序手动上传，复制文字不会附带图片；生成后的图片请回到「下载待归档」绑定到对应图位。AI 重拟会读取本文和当前公众号视觉规范，可能计费。</p>
    {references.error && <ErrorNote error={references.error} onRetry={() => references.refetch()} retryLabel="重新读取参考图"
      note={references.data ? '已保留上次读取的参考图；当前读取失败，请核对后重试。' : undefined} />}
    <section aria-label="品牌参考图" className="ice-asset-card" style={{ padding: 8, gap: 6 }}>
      {/* 批C（2026-10-25 候选对照轮）：未读取/读取失败/本图位暂无参考三者分明（C1）；
          折叠标题保留数量与上传说明（C2）；行身份用 data-reference-image（C3）。 */}
      {references.isLoading && <span className="ice-asset-muted" role="status">正在读取本图位参考…</span>}
      {!references.isLoading && !references.error && !references.data && <span className="ice-asset-muted">参考图尚未读取</span>}
      {references.data && (references.data.references.length
        ? <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="ice-link-btn" aria-expanded={referencesOpen}
                    onClick={() => setReferencesOpen(value => !value)}>
              {referencesOpen ? '收起参考图' : `展开参考图（当前图位参考 ${references.data.references.length} 张，按上传顺序）`}
            </button>
            <span className="ice-asset-muted">请按图片编号依次上传到 TapNow；复制提示词文字不会附带图片文件</span>
            <CopyButton text={references.data.references
              .map(row => '图片 ' + row.image + ' · '
                + (({ template: '编辑底图', identity: '品牌身份参考', style: '风格参考' } as Record<string, string>)[row.role] ?? '参考图')
                + ' · ' + (row.filename || row.title))
              .join('\n')}
              label="复制文件名清单" successLabel="清单已复制" />
          </div>
        : <span className="ice-asset-muted">本图位暂无参考图</span>)}
      {referencesOpen && !!references.data?.references.length && <ol className="ice-asset-grid">{references.data.references.map(row => <li key={row.image} data-reference-image={row.image}>
        <strong>图片 {row.image} · {({ template: '编辑底图', identity: '品牌身份参考', style: '风格参考' } as Record<string, string>)[row.role] ?? '参考图'}</strong>
        <p className="ice-asset-muted" style={{ overflowWrap: 'anywhere', margin: 0 }} title={row.filename || row.title}>{row.filename || row.title}</p>
        {(row.filename || row.title) && <CopyButton text={row.filename || row.title} label={`复制文件名（图片 ${row.image}）`} successLabel="文件名已复制" />}
        {row.resource_id
          ? <ImageThumbnail target={{ kind: 'resource', accountId: account, resourceId: row.resource_id, caption: row.title }} onOpen={setViewer} />
          : <span className="ice-asset-muted">仅有文件信息，暂无预览图</span>}
      </li>)}</ol>}
    </section>
    <textarea aria-label="当前图位生图提示词" rows={8} value={text} maxLength={30000} disabled={disabled} onChange={event => edit(event.target.value)} />
    <span className="ice-asset-muted" role="status">{text.length.toLocaleString()} / 30000 字符{disabled ? '' : text !== original ? ' · 未保存' : ' · 与已保存版本一致'}</span>
    <div className="ice-asset-row"><CopyButton label="复制生图提示词" text={text} />
      {text !== original && <span className="ice-badge ice-badge--warning" role="status">未保存修改</span>}
      <Button disabled={disabled || busy || budgetBusy} onClick={() => void onSave(text)}>保存提示词</Button>
      <Button variant="ghost" disabled={disabled || busy || budgetBusy || text === original} title="放弃当前修改，恢复到已保存版本"
              onClick={() => { edits.current++; setText(original); onDirty(false); }}>放弃修改</Button>
      <Button disabled={disabled || busy || budgetBusy || budget.data?.job.remaining === 0} onClick={() => void generate()}>{busy ? <><Spinner size={14} />正在重拟…</> : '按文章与品牌 AI 重拟'}</Button>
      <Button onClick={() => openWebsite('tapnow')}>打开内嵌 TapNow</Button></div>
    <div className="ice-asset-row"><span className="ice-asset-muted">{budget.data ? `本篇调用：${budget.data.job.used}/${budget.data.job.limit}，剩余 ${budget.data.job.remaining}` : '预算未读取'}</span>
      <Button size="sm" data-budget-entry disabled={!budget.data || disabled || busy || budgetBusy || editingBudget !== null} onClick={() => { returnBudgetFocus.current = false; setBudgetSaved(false); setBudgetError(null); setEditingBudget(budget.data!.job); setLimit(String(budget.data!.job.limit)); }}>调整本篇预算</Button>
      <Button size="sm" variant="ghost" onClick={() => settingsStore.set(true)}>模型与 Key 设置</Button></div>
    {budget.error && <ErrorNote error={budget.error} onRetry={() => void budget.refetch()} retryLabel="重新读取预算"
      note={budget.data ? '已保留最近确认的预算；当前刷新失败，请核对后重试。' : '本篇预算读取失败；已输入的提示词保留，可重新读取。'} />}
    {budgetSaved && <motion.p className="ice-asset-muted ice-budget-feedback" role="status"
      initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : 0.16 }}>
      {budget.error ? '本篇预算已保存；用量刷新失败，可重新读取预算。' : budget.isFetching ? '本篇预算已保存，正在刷新用量…' : '本篇预算已保存。'}
    </motion.p>}
    {editingBudget && <div ref={budgetFormRef} className="ice-asset-card"><label className="ice-asset-row">本篇模型调用上限
      <Input ref={limitRef} aria-label="本篇模型调用上限" type="number" min={Math.max(1, editingBudget.used)} max={100} value={limit} disabled={budgetBusy} onChange={event => setLimit(event.target.value)} /></label>
      <p className="ice-asset-muted">1–100 次，不能低于已用次数。仅修改本篇，不重置已用次数；保存后生效。</p>
      <div className="ice-asset-row"><Button loading={budgetBusy} disabled={disabled} onClick={() => void saveBudget()}>保存本篇预算</Button><Button disabled={budgetBusy} variant="ghost" onClick={() => { closeBudget(); setBudgetError(null); }}>取消预算调整</Button></div>
      {budgetError != null && <ErrorNote error={budgetError} note="预算调整未完成，请核对后重试或取消。" />}</div>}
    {busy && <p role="status" className="ice-asset-muted">可以继续编辑；返回的候选不会覆盖生成期间新增的修改。</p>}
    {error != null && <ErrorNote error={error} note="你已输入的内容保留。" />}
    {candidate && <div className="ice-asset-grid"><p className="ice-asset-muted">你已继续编辑，AI 候选保留在下方，未覆盖当前内容。</p>
      <textarea aria-label="未覆盖编辑的AI提示词候选" readOnly rows={5} value={candidate} /><CopyButton label="复制AI提示词候选" text={candidate} />
      <Button disabled={disabled} onClick={() => { edit(candidate); setCandidate(null); }}>用候选替换当前提示词</Button></div>}
    {viewer && <ImageViewer target={viewer} onClose={() => setViewer(null)} />}
  </section>;
}
