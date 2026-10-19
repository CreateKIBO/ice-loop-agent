import * as React from 'react';
import { Banner, Button, Input, Spinner } from '../../components/ui';
import { CopyButton } from '../../components/CopyButton';
import { settingsStore } from '../../app/uiState';
import { rpc, useAccountQuery, useCurrentAccount } from '../../data/client';
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
  const [error, setError] = React.useState<string | null>(null), [viewer, setViewer] = React.useState<ImageTarget | null>(null);
  const [editingBudget, setEditingBudget] = React.useState<Budget | null>(null), [limit, setLimit] = React.useState(''), [budgetBusy, setBudgetBusy] = React.useState(false);
  const mounted = React.useRef(true);
  const references = useAccountQuery<{ references: Reference[] }>('prompts.references', params, { enabled: !disabled, staleTime: 0, gcTime: 10000 });
  const budget = useAccountQuery<{ job: Budget }>('budgets.get', { job_id: data.job.job_id });
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
    } catch (problem) { if (mounted.current) setError((problem as Error).message); }
    finally { busyRef.current = false; if (mounted.current) { setBusy(false); void budget.refetch(); } }
  };
  const saveBudget = async () => {
    if (!editingBudget || busyRef.current || disabled) return;
    const maximum = Number(limit);
    if (!/^\d+$/.test(limit) || !Number.isInteger(maximum) || maximum < Math.max(1, editingBudget.used) || maximum > 100) {
      setError(`本篇上限需为 ${Math.max(1, editingBudget.used)}–100 的整数，不能低于已用次数`); return;
    }
    busyRef.current = true; setBudgetBusy(true); setError(null);
    try {
      await rpc('budgets.save', { account_id: account, job_id: data.job.job_id, scope: 'job', limit: maximum, limits_hash: editingBudget.limits_hash });
      if (mounted.current) { setEditingBudget(null); await budget.refetch(); }
    } catch (problem) { if (mounted.current) setError((problem as Error).message); }
    finally { busyRef.current = false; if (mounted.current) setBudgetBusy(false); }
  };
  return <section className="ice-asset-card" aria-label="生图提示词">
    <h4>提示词与品牌参考</h4><p className="ice-asset-muted">参考图需要在 TapNow 按顺序手动上传，复制文字不会附带图片。AI 重拟会读取本文和当前公众号视觉规范，可能计费。</p>
    {references.error && <Banner tone="warning" title="参考图读取失败">{references.error.message}</Banner>}
    {!!references.data?.references.length && <ol className="ice-asset-grid">{references.data.references.map(row => <li key={row.image}>
      <strong>图片 {row.image} · {({ template: '编辑底图', identity: '品牌身份参考', style: '风格参考' } as Record<string, string>)[row.role] ?? '参考图'}</strong>
      <p className="ice-asset-muted">{row.filename || row.title}</p>
      {row.resource_id && <ImageThumbnail target={{ kind: 'resource', accountId: account, resourceId: row.resource_id, caption: row.title }} onOpen={setViewer} />}
    </li>)}</ol>}
    <textarea aria-label="当前图位生图提示词" rows={8} value={text} maxLength={30000} disabled={disabled} onChange={event => edit(event.target.value)} />
    <div className="ice-asset-row"><CopyButton label="复制生图提示词" text={text} />
      <Button disabled={disabled || busy || budgetBusy || !text.trim()} onClick={() => void onSave(text)}>保存提示词</Button>
      <Button disabled={disabled || busy || budgetBusy || budget.data?.job.remaining === 0} onClick={() => void generate()}>{busy ? <><Spinner size={14} />正在重拟…</> : '按文章与品牌 AI 重拟'}</Button>
      <Button onClick={() => openWebsite('tapnow')}>打开内嵌 TapNow</Button></div>
    <div className="ice-asset-row"><span className="ice-asset-muted">{budget.data ? `本篇调用：${budget.data.job.used}/${budget.data.job.limit}，剩余 ${budget.data.job.remaining}` : '预算未读取'}</span>
      <Button size="sm" disabled={!budget.data || disabled || busy || budgetBusy} onClick={() => { setEditingBudget(budget.data!.job); setLimit(String(budget.data!.job.limit)); }}>调整本篇预算</Button>
      <Button size="sm" variant="ghost" onClick={() => settingsStore.set(true)}>模型与 Key 设置</Button></div>
    {editingBudget && <div className="ice-asset-card"><label className="ice-asset-row">本篇模型调用上限
      <Input aria-label="本篇模型调用上限" type="number" min={Math.max(1, editingBudget.used)} max={100} value={limit} disabled={budgetBusy} onChange={event => setLimit(event.target.value)} /></label>
      <p className="ice-asset-muted">1–100 次，不能低于已用次数。仅修改本篇，不重置已用次数；保存后生效。</p>
      <div className="ice-asset-row"><Button disabled={budgetBusy || disabled} onClick={() => void saveBudget()}>保存本篇预算</Button><Button disabled={budgetBusy} variant="ghost" onClick={() => setEditingBudget(null)}>取消预算调整</Button></div></div>}
    {busy && <p role="status" className="ice-asset-muted">可以继续编辑；返回的候选不会覆盖生成期间新增的修改。</p>}
    {error && <Banner tone="danger" title="操作未完成">{error}。你已输入的内容保留。</Banner>}
    {candidate && <div className="ice-asset-grid"><p className="ice-asset-muted">你已继续编辑，AI 候选保留在下方，未覆盖当前内容。</p>
      <textarea aria-label="未覆盖编辑的AI提示词候选" readOnly rows={5} value={candidate} /><CopyButton label="复制AI提示词候选" text={candidate} />
      <Button disabled={disabled} onClick={() => { edit(candidate); setCandidate(null); }}>用候选替换当前提示词</Button></div>}
    {viewer && <ImageViewer target={viewer} onClose={() => setViewer(null)} />}
  </section>;
}
