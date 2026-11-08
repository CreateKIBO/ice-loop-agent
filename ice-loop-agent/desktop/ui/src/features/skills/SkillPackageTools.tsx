// v3.15 写作技能：导入（Markdown / ZIP）、导出 Markdown、版本历史、恢复预装。
// 导入只解析不写入：确认后加入编辑列表，点“保存设置”才生效并记一版历史。
import * as React from 'react';
import { Banner, Button, Dialog, Input, Spinner } from '../../components/ui';
import { toast } from '../../components/toast';
import { accountStore, rpc } from '../../data/client';

export type SkillSource = { kind: 'import' | 'copy' | 'default' | 'restore'; file_name?: string; sha256?: string; format?: string;
  imported_at?: string; from_skill_id?: string; from_version?: number; original_version?: number };
export type ParsedSkill = { name: string; instructions: string; rules: Record<string, unknown>; source: SkillSource; kind?: 'main' | 'addon' };
type ParseResult = { skill: ParsedSkill; warnings: string[]; ignored_files: string[] };
type VersionRow = { version: number; name: string; chars: number; rule_count: number; created_at: string | null;
  source: SkillSource | null; current: boolean };
type VersionDetail = { skill_id: string; version: number; name: string; instructions: string; rules: Record<string, unknown>;
  source: SkillSource | null; created_at: string | null };

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
    const exported = await rpc<{ markdown: string; file_name: string }>('skills.export', params);
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
        <Button variant="primary" disabled={!name.trim()} onClick={() => {
          if (!preview) return;
          onImport({ ...preview.skill, name: name.trim().slice(0, 80) }); setPreview(null);
          toast.info({ title: '已加入技能列表', detail: '检查内容后点“保存设置”才会生效。' });
        }}>加入技能列表</Button></>}>
      {preview && <div className="ice-skills__import">
        <label>技能名称<Input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <p className="ice-skills__note">{preview.skill.kind === 'addon' ? '辅助技能 · ' : ''}{sourceText(preview.skill.source)} · 指令 {preview.skill.instructions.length} 字 · 检查规则 {rules.length} 项{rules.length ? `（${rules.join('、')}）` : ''}</p>
        {preview.warnings.length > 0 && <Banner tone="warning" title="请留意">
          <ul className="ice-skills__list">{preview.warnings.map(text => <li key={text}>{text}</li>)}</ul></Banner>}
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
