// v3.15 写作技能：导入（Markdown / ZIP）、导出 Markdown、版本历史、恢复预装。
// 导入只解析不写入：确认后加入编辑列表，点“保存设置”才生效并记一版历史。
import * as React from 'react';
import { Banner, Button, Dialog, Input, Spinner } from '../../components/ui';
import { toast } from '../../components/toast';
import { accountStore, rpc } from '../../data/client';
import { ConflictList, type TextConflict } from './SkillScope';

export type SkillSource = { kind: 'import' | 'copy' | 'default' | 'restore'; file_name?: string; sha256?: string; format?: string;
  imported_at?: string; from_skill_id?: string; from_version?: number; original_version?: number };
// v3.19 参考资料与示例：技能里只记引用，正文由 skills.files_add 单独保存。
export type FileStage = 'plan' | 'write' | 'review';
export type SkillFileRef = { id: string; name: string; kind: 'reference' | 'example'; stages: FileStage[]; chars?: number };
export type ParsedSkill = { name: string; instructions: string; rules: Record<string, unknown>; source: SkillSource; kind?: 'main' | 'addon';
  files?: SkillFileRef[] };
type PackageFile = { name: string; path: string; kind: 'reference' | 'example'; stages: FileStage[]; text: string; chars: number };
type ParseResult = { skill: ParsedSkill; warnings: string[]; ignored_files: string[]; files?: PackageFile[] };
export const STAGE_LABEL: Record<FileStage, string> = { plan: '构思', write: '写作', review: '审阅' };
const STAGES: FileStage[] = ['plan', 'write', 'review'];
const MAX_FILES = 10;

/** 保存参考文件正文，返回引用（阶段用传入的值）。 */
async function addFiles(items: Array<{ name: string; kind: 'reference' | 'example'; text: string; stages?: FileStage[] }>) {
  const result = await rpc<{ files: SkillFileRef[] }>('skills.files_add', { account_id: accountStore.get(),
    files: items.map(({ name, kind, text }) => ({ name, kind, text })) });
  return result.files.map((ref, i) => ({ ...ref, stages: items[i].stages?.length ? items[i].stages! : ref.stages }));
}
type VersionRow = { version: number; name: string; chars: number; rule_count: number; created_at: string | null;
  source: SkillSource | null; current: boolean };
type VersionDetail = { skill_id: string; version: number; name: string; instructions: string; rules: Record<string, unknown>;
  source: SkillSource | null; created_at: string | null; files?: SkillFileRef[] };

const MAX_FILE = 1_000_000;

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const day = (value?: string | null) => value ? value.slice(0, 16).replace('T', ' ') : '';

/** 来源说明：导入自哪个文件、复制自哪一版、恢复自预装或历史版本。 */
export function sourceText(source?: SkillSource | null, nameOf: (id: string) => string | undefined = () => undefined) {
  if (!source) return '';
  if (source.kind === 'import') return `导入自 ${source.file_name ?? '文件'}${source.imported_at ? `（${day(source.imported_at)}）` : ''}`;
  if (source.kind === 'copy') return `复制自 ${(source.from_skill_id && nameOf(source.from_skill_id)) || source.from_skill_id || '其他技能'}${source.from_version ? ` v${source.from_version}` : ''}`;
  if (source.kind === 'restore') return `恢复自 v${source.from_version ?? '?'}`;
  return '预装内容';
}

/** 导出 Markdown：桌面应用里弹出保存对话框；开发浏览器里复制到剪贴板。导出的是已保存的版本。 */
export async function exportSkill(skillId: string, version?: number) {
  const account = accountStore.get();
  const params = { account_id: account, skill_id: skillId, ...(version ? { version } : {}) };
  try {
    if (window.ice?.exportSkill) {
      const result = await window.ice.exportSkill(params);
      if (result) toast.success({ title: '技能已导出', detail: result.file });
      return;
    }
    const exported = await rpc<{ markdown?: string; file_name: string }>('skills.export', params);
    if (exported.markdown === undefined) { toast.warning({ title: '当前环境不能保存 ZIP', detail: '带参考文件的技能请在桌面应用里导出。' }); return; }
    await navigator.clipboard.writeText(exported.markdown);
    toast.success({ title: '已复制技能 Markdown', detail: `当前环境不能保存文件；可粘贴为 ${exported.file_name}` });
  } catch (error) { toast.error({ title: '没有导出', detail: (error as Error).message }); }
}

/** 选择文件 → 引擎解析 → 预览（名称可改、提示、未导入文件）→ 加入列表。 */
export function ImportSkillButton({ disabled, onImport }: { disabled?: boolean; onImport: (skill: ParsedSkill) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [preview, setPreview] = React.useState<ParseResult | null>(null);
  const [name, setName] = React.useState('');
  const read = async (file: File) => {
    if (file.size > MAX_FILE) { toast.error({ title: '文件过大', detail: '技能文件或 ZIP 包最多 1MB' }); return; }
    const account = accountStore.get();
    setBusy(true);
    try {
      const data = toBase64(new Uint8Array(await file.arrayBuffer()));
      const result = await rpc<ParseResult>('skills.import_parse', { account_id: account, file_name: file.name, data_base64: data });
      if (accountStore.get() !== account) return;
      setName(result.skill.name); setPreview(result);
    } catch (error) { toast.error({ title: '没有读取这个技能', detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const rules = preview ? Object.keys(preview.skill.rules) : [];
  return <>
    <Button size="sm" loading={busy} disabled={disabled} onClick={() => input.current?.click()}
            title="导入 Markdown（.md/.txt）或含 SKILL.md 的 ZIP 包；先预览，加入后点“保存设置”才生效">导入技能</Button>
    <input ref={input} type="file" hidden accept=".md,.markdown,.txt,.zip" aria-label="选择技能文件"
           onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file); }} />
    <Dialog open={preview !== null} onOpenChange={open => { if (!open) setPreview(null); }} title="导入写作技能" width={640}
      description="只导入写作指令和检查规则；不会安装依赖、运行脚本，也不会授予任何工具或发布权限。"
      footer={<>
        <Button onClick={() => setPreview(null)}>取消</Button>
        <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={async () => {
          if (!preview) return;
          let files: SkillFileRef[] | undefined;
          if (preview.files?.length) {
            setBusy(true);
            try { files = await addFiles(preview.files); }
            catch (error) { toast.error({ title: '参考文件没有保存', detail: (error as Error).message }); return; }
            finally { setBusy(false); }
          }
          onImport({ ...preview.skill, name: name.trim().slice(0, 80), ...(files ? { files } : {}) }); setPreview(null);
          toast.info({ title: '已加入技能列表', detail: '检查内容后点“保存设置”才会生效。' });
        }}>加入技能列表</Button></>}>
      {preview && <div className="ice-skills__import">
        <label>技能名称<Input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <p className="ice-skills__note">{preview.skill.kind === 'addon' ? '辅助技能 · ' : ''}{sourceText(preview.skill.source)} · 指令 {preview.skill.instructions.length} 字 · 检查规则 {rules.length} 项{rules.length ? `（${rules.join('、')}）` : ''}</p>
        {preview.warnings.length > 0 && <Banner tone="warning" title="请留意">
          <ul className="ice-skills__list">{preview.warnings.map(text => <li key={text}>{text}</li>)}</ul></Banner>}
        {(preview.files?.length ?? 0) > 0 && <div className="ice-skills__note">一起导入的参考文件：
          <ul className="ice-skills__list">{preview.files!.map(f => <li key={f.path}>{f.kind === 'example' ? '示例' : '参考'} · {f.path} · {f.chars} 字 · 用于{f.stages.map(x => STAGE_LABEL[x]).join('、')}</li>)}</ul></div>}
        {preview.ignored_files.length > 0 && <p className="ice-skills__note">未导入的文件：{preview.ignored_files.slice(0, 12).join('、')}{preview.ignored_files.length > 12 ? ` 等 ${preview.ignored_files.length} 个` : ''}</p>}
        <pre className="ice-skills__preview" aria-label="写作指令预览">{preview.skill.instructions}</pre>
      </div>}
    </Dialog>
  </>;
}

/** 恢复预装：缺少的预装技能可重新加入；已有的可用预装内容替换编辑区（保存后成为新版本，不会自动启用）。 */
export function RestoreDefaultsButton({ disabled, present, onAdd, onReplace }: {
  disabled?: boolean; present: (id: string) => boolean;
  onAdd: (skill: ParsedSkill & { id: string }) => void; onReplace: (skill: ParsedSkill & { id: string }) => void;
}) {
  const [items, setItems] = React.useState<Array<ParsedSkill & { id: string }> | null>(null);
  const [busy, setBusy] = React.useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const result = await rpc<{ skills: Array<{ id: string; name: string; instructions: string; rules: Record<string, unknown> }> }>(
        'skills.defaults', { account_id: accountStore.get() });
      setItems(result.skills.map(skill => ({ ...skill, source: { kind: 'default' } })));
    } catch (error) { toast.error({ title: '没有读取预装技能', detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  return <>
    <Button size="sm" variant="ghost" loading={busy} disabled={disabled} onClick={() => void open()}>恢复预装技能</Button>
    <Dialog open={items !== null} onOpenChange={value => { if (!value) setItems(null); }} title="恢复预装技能" width={520}
      description="由你主动恢复；不会覆盖其他技能，也不会自动设为主技能。替换后在编辑区核对，点“保存设置”才生效并记一版历史。"
      footer={<Button onClick={() => setItems(null)}>关闭</Button>}>
      <ul className="ice-skills__list">{(items ?? []).map(skill => <li key={skill.id} className="ice-skills__choice">
        <span>{skill.name} <small>{skill.instructions.length} 字 · 规则 {Object.keys(skill.rules).length} 项</small></span>
        {present(skill.id)
          ? <Button size="sm" onClick={() => { onReplace(skill); setItems(null); }}>用预装内容替换编辑区</Button>
          : <Button size="sm" variant="primary" onClick={() => { onAdd(skill); setItems(null); }}>重新加入</Button>}
      </li>)}</ul>
    </Dialog>
  </>;
}

/** 版本历史：只在打开时读取；可预览、导出某一版，或载入到编辑区（保存后成为新版本）。 */
export function SkillHistory({ skillId, onLoad, onClose }: { skillId: string; onLoad: (detail: VersionDetail) => void; onClose: () => void }) {
  const [rows, setRows] = React.useState<VersionRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<VersionDetail | null>(null);
  React.useEffect(() => {
    let live = true;
    setRows(null); setPicked(null); setError(null);
    rpc<{ versions: VersionRow[] }>('skills.versions', { account_id: accountStore.get(), skill_id: skillId })
      .then(result => { if (live) setRows(result.versions); }, problem => { if (live) setError((problem as Error).message); });
    return () => { live = false; };
  }, [skillId]);
  const pick = async (version: number) => {
    try { setPicked(await rpc<VersionDetail>('skills.version', { account_id: accountStore.get(), skill_id: skillId, version })); }
    catch (problem) { toast.error({ title: '没有读取这一版', detail: (problem as Error).message }); }
  };
  return <section className="ice-skills__history" aria-label="版本历史">
    <div className="ice-skills__row"><strong>版本历史</strong><span style={{ flex: 1 }} />
      <Button size="sm" variant="ghost" onClick={onClose}>收起</Button></div>
    {error && <p className="ice-skills__note">{/没有这个技能/.test(error) ? '新技能保存后才有版本历史。' : error}</p>}
    {!rows && !error && <span role="status"><Spinner size={12} /> 正在读取…</span>}
    {rows && <ul className="ice-skills__list">{rows.map(row => <li key={row.version} className="ice-skills__choice">
      <button type="button" className="ice-link-btn" aria-pressed={picked?.version === row.version} onClick={() => void pick(row.version)}>
        v{row.version}{row.current ? '（当前）' : ''}</button>
      <small>{row.name} · {row.chars} 字 · 规则 {row.rule_count} 项{row.created_at ? ` · ${day(row.created_at)}` : ''}{row.source ? ` · ${sourceText(row.source)}` : ''}</small>
    </li>)}</ul>}
    {picked && <div className="ice-skills__import">
      <pre className="ice-skills__preview" aria-label={`v${picked.version} 写作指令`}>{picked.instructions}</pre>
      <div className="ice-skills__row">
        <Button size="sm" onClick={() => void exportSkill(skillId, picked.version)}>导出 v{picked.version}</Button>
        <Button size="sm" variant="primary" onClick={() => onLoad(picked)}>载入 v{picked.version} 到编辑区</Button>
      </div>
      <p className="ice-skills__note">载入后点“保存设置”才生效，会作为新版本保存；历史版本本身不变。</p>
    </div>}
  </section>;
}

/** v3.19 技能编辑区：参考资料与示例。改动只进编辑列表，点“保存设置”才生效并记一版。 */
export function SkillFiles({ files, disabled, onChange }: { files: SkillFileRef[]; disabled?: boolean; onChange: (next: SkillFileRef[]) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [view, setView] = React.useState<{ id: string; text: string } | null>(null);
  const add = async (list: FileList) => {
    const picked = Array.from(list).slice(0, MAX_FILES - files.length);
    if (!picked.length) return;
    setBusy(true);
    try {
      const items = await Promise.all(picked.map(async file => {
        if (file.size > 200_000) throw Error(`「${file.name}」过大，参考文件最多 2 万字`);
        return { name: file.name.slice(0, 120), kind: /example|示例|范文|样例/i.test(file.name) ? 'example' as const : 'reference' as const, text: await file.text() };
      }));
      const refs = await addFiles(items);
      onChange([...files, ...refs.filter(ref => !files.some(f => f.id === ref.id))]);
    } catch (error) { toast.error({ title: '没有添加参考文件', detail: (error as Error).message }); }
    finally { setBusy(false); }
  };
  const open = async (id: string) => {
    if (view?.id === id) { setView(null); return; }
    try { const file = await rpc<{ text: string }>('skills.file_get', { account_id: accountStore.get(), file_id: id }); setView({ id, text: file.text }); }
    catch (error) { toast.error({ title: '没有读取参考文件', detail: (error as Error).message }); }
  };
  const update = (id: string, patch: Partial<SkillFileRef>) => onChange(files.map(f => f.id === id ? { ...f, ...patch } : f));
  return <div className="ice-skills__files" role="group" aria-label="参考资料与示例">
    <div className="ice-skills__row"><strong>参考资料与示例</strong><small>（{files.length}/{MAX_FILES}）按阶段放进提示词；示例只学结构与语气，不照抄</small>
      <span style={{ flex: 1 }} />
      <Button size="sm" loading={busy} disabled={disabled || files.length >= MAX_FILES} onClick={() => input.current?.click()}>添加文件</Button>
      <input ref={input} type="file" hidden multiple accept=".md,.markdown,.txt" aria-label="选择参考文件"
             onChange={event => { const list = event.target.files; if (list) void add(list); event.target.value = ''; }} /></div>
    {files.length === 0 && <small>可以放风格指南、术语表、范文等文字资料（.md / .txt，单个 ≤2 万字）。</small>}
    {files.map(file => <div key={file.id} className="ice-skills__file">
      <div className="ice-skills__row">
        <span className="ice-skills__file-name">{file.name}</span>{file.chars ? <small>{file.chars} 字</small> : null}
        <select aria-label={`「${file.name}」的类型`} disabled={disabled} value={file.kind}
                onChange={event => update(file.id, { kind: event.target.value as SkillFileRef['kind'] })}>
          <option value="reference">参考资料</option><option value="example">示例</option>
        </select>
        {STAGES.map(stage => { const on = file.stages.includes(stage);
          return <label key={stage} className="ice-skills__check"><input type="checkbox" disabled={disabled || (on && file.stages.length === 1)} checked={on}
            onChange={() => update(file.id, { stages: on ? file.stages.filter(x => x !== stage) : STAGES.filter(x => x === stage || file.stages.includes(x)) })} />{STAGE_LABEL[stage]}</label>; })}
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" aria-pressed={view?.id === file.id} onClick={() => void open(file.id)}>{view?.id === file.id ? '收起' : '查看'}</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { onChange(files.filter(f => f.id !== file.id)); if (view?.id === file.id) setView(null); }}>移除</Button>
      </div>
      {view?.id === file.id && <pre className="ice-skills__preview" aria-label={`「${file.name}」内容`}>{view.text}</pre>}
    </div>)}
  </div>;
}

// ------------------------------------------------------------------ v3.20 冲突检查
type RuleReport = { method: 'rules'; conflicts: TextConflict[]; checked: string[]; skills: Array<{ id: string; name: string }> };
type AiConflict = { label: string; skill_a: string; quote_a: string; skill_b: string; quote_b: string; severity: 'high' | 'low'; advice: string; verified: boolean };
type AiReport = { method: 'ai'; conflicts: AiConflict[]; notes: string; model_id: string };
export type CheckSkill = { id: string; name: string; instructions: string; kind?: 'main' | 'addon'; rules: Record<string, unknown> };

/** 检查当前编辑中的组合（未保存也能查）。规则检查即时、不调模型；AI 深入检查调用一次写作模型，只作提示。 */
export function ConflictCheck({ skills, disabled }: { skills: () => CheckSkill[] | string; disabled?: boolean }) {
  const [rules, setRules] = React.useState<RuleReport | null>(null);
  const [ai, setAi] = React.useState<AiReport | null>(null);
  const [busy, setBusy] = React.useState<'rules' | 'ai' | null>(null);
  const run = async (kind: 'rules' | 'ai') => {
    const chosen = skills();
    if (typeof chosen === 'string') { toast.warning({ title: '还不能检查', detail: chosen }); return; }
    setBusy(kind);
    try {
      const params = { account_id: accountStore.get(), skills: chosen };
      if (kind === 'rules') { setRules(await rpc<RuleReport>('skills.check_conflicts', params)); }
      else { setAi(await rpc<AiReport>('skills.check_conflicts_ai', params)); }
    } catch (error) { toast.error({ title: kind === 'ai' ? 'AI 检查没有完成' : '检查没有完成', detail: (error as Error).message }); }
    finally { setBusy(null); }
  };
  return <div className="ice-skills__check-panel" role="group" aria-label="冲突检查">
    <div className="ice-skills__row">
      <strong>冲突检查</strong><small>检查当前选中的主技能 + 辅助技能（含未保存的修改）</small>
      <span style={{ flex: 1 }} />
      <Button size="sm" loading={busy === 'rules'} disabled={disabled || busy !== null} onClick={() => void run('rules')}>检查冲突</Button>
      <Button size="sm" variant="ghost" loading={busy === 'ai'} disabled={disabled || busy !== null} title="调用一次写作模型，按模型计费；结果只作提示" onClick={() => void run('ai')}>AI 深入检查</Button>
    </div>
    {rules && (rules.conflicts.length
      ? <><p className="ice-skills__note">发现 {rules.conflicts.length} 处可能冲突（{rules.skills.map(s => s.name).join(' + ')}）：</p><ConflictList conflicts={rules.conflicts} /></>
      : <p className="ice-skills__note" role="status">没有发现明确冲突（{rules.skills.map(s => s.name).join(' + ')}）。已检查：{rules.checked.join('、')}。规则检查只认明确的说法，细微矛盾可用 AI 深入检查。</p>)}
    {ai && <div className="ice-skills__note" role="status">
      <strong>AI 深入检查</strong>{ai.model_id ? `（${ai.model_id}）` : ''}：{ai.conflicts.length ? `${ai.conflicts.length} 处` : '没有发现冲突'}{ai.notes ? `。${ai.notes}` : ''}
      {ai.conflicts.length > 0 && <ul className="ice-skills__conflicts">{ai.conflicts.map((c, i) => <li key={i}>
        <strong>{c.label}</strong>{c.severity === 'high' ? '（明显）' : ''}：
        <span className="ice-skills__conflict-item">「{c.skill_a}」<q>{c.quote_a}</q></span>
        <span className="ice-skills__conflict-item">「{c.skill_b}」<q>{c.quote_b}</q></span>
        {!c.verified && <small>（原文未能在技能里逐字找到，请自行核对）</small>}
        {c.advice && <small>{c.advice}</small>}
      </li>)}</ul>}
    </div>}
  </div>;
}
