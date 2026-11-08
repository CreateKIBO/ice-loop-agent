import * as React from 'react';
import { Banner, Button, Dialog, Input, SkeletonRows } from '../../components/ui';
import { toast } from '../../components/toast';
import { accountStore, dirtyStore, queryClient, registerDirtyFlush, rpc, useAccountQuery, useCurrentAccount } from '../../data/client';
import { skillSettingsStore } from '../../app/uiState';
import { ConflictCheck, ImportSkillButton, RestoreDefaultsButton, SkillFiles, SkillHistory, exportSkill, sourceText, type CheckSkill, type ParsedSkill, type SkillFileRef, type SkillSource } from './SkillPackageTools';
import '../../styles/skills.css';

type Skill = { id: string; name: string; instructions: string; rules: Record<string, unknown>; version: number; source?: SkillSource; kind?: 'main' | 'addon';
  files?: SkillFileRef[] };
// v3.16：系列绑定，缺少的键表示沿用公众号设置。
type Binding = { main?: string | null; addons?: string[] };
type Snapshot = { account_id: string; revision: number; state_hash: string; active_skill_id: string | null; skills: Skill[];
  active_addon_ids?: string[]; series_bindings?: Record<string, Binding> };
type DraftSkill = Omit<Skill, 'rules'> & { rulesText: string };
type Draft = { active_skill_id: string | null; active_addon_ids: string[]; series_bindings: Record<string, Binding>; skills: DraftSkill[] };
const MAX_ADDONS = 5;
const isAddon = (skill: { kind?: string }) => skill.kind === 'addon';

function toDraft(state: Snapshot): Draft {
  return { active_skill_id: state.active_skill_id, active_addon_ids: state.active_addon_ids ?? [], series_bindings: state.series_bindings ?? {},
    skills: state.skills.map(({ rules, ...skill }) => ({ ...skill, rulesText: JSON.stringify(rules, null, 2) })) };
}

/** 去掉对某个技能的引用（移除技能、或改了类型后），系列绑定里变空的条目一并删除。 */
function dropRefs(value: Draft, id: string, from: 'main' | 'addon' | 'both'): Draft {
  const series: Record<string, Binding> = {};
  for (const [name, binding] of Object.entries(value.series_bindings)) {
    const next: Binding = { ...binding };
    if (from !== 'addon' && next.main === id) delete next.main;
    if (from !== 'main' && next.addons) next.addons = next.addons.filter(a => a !== id);
    if (Object.keys(next).length) series[name] = next;
  }
  return { ...value, series_bindings: series,
    active_skill_id: from !== 'addon' && value.active_skill_id === id ? null : value.active_skill_id,
    active_addon_ids: from !== 'main' ? value.active_addon_ids.filter(a => a !== id) : value.active_addon_ids };
}

export function SkillSettings() {
  const account = useCurrentAccount();
  const query = useAccountQuery<Snapshot>('skills.get', {}, { staleTime: 0, refetchOnMount: 'always' });
  const [draft, setDraft] = React.useState<Draft | null>(null), [base, setBase] = React.useState(''), [hash, setHash] = React.useState('');
  const [editing, setEditing] = React.useState(''), [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<'close' | 'reload' | null>(null);
  const [history, setHistory] = React.useState(false);
  const [seriesOpen, setSeriesOpen] = React.useState(false);
  const lock = React.useRef(false), active = React.useRef(true), changed = React.useRef(false);
  const dirty = Boolean(draft && JSON.stringify(draft) !== base), key = 'skills:' + account;
  changed.current = dirty;
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  React.useLayoutEffect(() => { if (dirty || busy) dirtyStore.markDirty(key); else dirtyStore.markClean(key); }, [dirty, busy, key]);
  React.useEffect(() => {
    const off = registerDirtyFlush(key, () => {
      if (lock.current) throw Error('技能正在保存，请稍候');
      if (changed.current) throw Error('技能有未保存修改，请先保存或放弃');
    });
    return () => { off(); dirtyStore.markClean(key); };
  }, [key]);
  const install = (state: Snapshot) => {
    const next = toDraft(state);
    setDraft(next); setBase(JSON.stringify(next)); setHash(state.state_hash);
    setEditing(previous => next.skills.some(s => s.id === previous) ? previous : next.active_skill_id ?? next.skills[0].id);
    changed.current = false; dirtyStore.markClean(key); setError(null); setPending(null);
  };
  React.useEffect(() => { if (!draft && query.data?.account_id === account) install(query.data); }, [query.data, draft, account]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (update: (value: Draft) => Draft) => {
    if (lock.current) return;
    changed.current = true; dirtyStore.markDirty(key);
    setDraft(previous => previous && update(previous)); setPending(null); setError(null);
  };
  const edit = (id: string, values: Partial<DraftSkill>) => change(value => ({ ...value, skills: value.skills.map(s => s.id === id ? { ...s, ...values } : s) }));
  const current = () => active.current && accountStore.get() === account;
  // v3.15：导入、复制、恢复预装都只改编辑列表；点“保存设置”才生效，并在历史里记一版。
  const uniqueName = (name: string, skills: DraftSkill[]) => skills.some(s => s.name === name) ? `${name}（${skills.length + 1}）`.slice(0, 80) : name;
  const addSkill = (id: string, skill: ParsedSkill) => {
    change(value => ({ ...value, skills: [...value.skills, { id, name: uniqueName(skill.name, value.skills), instructions: skill.instructions,
      rulesText: JSON.stringify(skill.rules, null, 2), version: 1, source: skill.source, kind: skill.kind ?? 'main',
      ...(skill.files?.length ? { files: skill.files } : {}) }] }));
    setEditing(id); setHistory(false);
  };
  // 上次保存的技能（导出按钮用）；base 只在读取/保存后变化，避免每次渲染都解析整份设置。
  const savedSkills = React.useMemo(() => (JSON.parse(base || '{"skills":[]}') as Draft).skills, [base]);
  const savedSkill = (id: string) => savedSkills.find(s => s.id === id);
  const save = async () => {
    if (!draft || !hash || lock.current) return;
    lock.current = true; setBusy(true); setError(null); dirtyStore.markDirty(key);
    try {
      const skills = draft.skills.map(({ rulesText, ...skill }) => {
        let rules: unknown;
        try { rules = JSON.parse(rulesText); } catch { throw Error(`「${skill.name}」的检查规则不是有效 JSON`); }
        if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw Error(`「${skill.name}」的检查规则需为 JSON 对象`);
        return { ...skill, rules };
      });
      const result = await rpc<Snapshot>('skills.save', { account_id: account, state_hash: hash, skills, active_skill_id: draft.active_skill_id,
        active_addon_ids: draft.active_addon_ids, series_bindings: draft.series_bindings });
      if (!current()) return;
      install(result);
      queryClient.setQueryData(['ice', account, 'skills.get', {}], result);
      void queryClient.invalidateQueries({ queryKey: ['ice', account, 'skills.resolve'] }); // 编辑器里“本篇使用”随之更新
      toast.success({ title: '技能设置已保存', detail: '后续新内容使用此配置；已创建文章与原回复重试保留原技能版本。' });
    } catch (problem) { if (current()) setError((problem as Error).message); }
    finally { lock.current = false; if (current()) setBusy(false); }
  };
  const reload = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); dirtyStore.markDirty(key);
    try {
      const state = await rpc<Snapshot>('skills.get', { account_id: account });
      if (current()) { install(state); queryClient.setQueryData(['ice', account, 'skills.get', {}], state); }
    } catch (problem) { if (current()) setError((problem as Error).message); }
    finally { lock.current = false; if (current()) setBusy(false); }
  };
  const close = () => { if (!lock.current) { if (changed.current) setPending('close'); else skillSettingsStore.set(false); } };
  const selected = draft?.skills.find(s => s.id === editing);
  let parsed: Record<string, unknown> | null = null;
  try { const value = JSON.parse(selected?.rulesText ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value; } catch { /* Raw input is kept for correction. */ }
  const updateRule = (rule: string, value: unknown) => {
    if (selected && parsed) edit(selected.id, { rulesText: JSON.stringify({ ...parsed,
      ...(rule === 'required_ending_heading' && value === '' ? { ending_triad: {}, brand_sentence_pattern: '' } : {}), [rule]: value }, null, 2) });
  };
  return <Dialog open onOpenChange={next => { if (!next) close(); }} title="写作技能" width={980}
    description="为当前公众号选择一个主写作技能，可叠加辅助技能，也可按系列或单篇另选。技能只影响写作与检查，不授予工具或发布权限。"
    footer={pending ? <>
      <span className="ice-skills__status" role="status">有修改尚未保存。</span>
      <Button disabled={busy} onClick={() => setPending(null)}>继续编辑</Button>
      <Button variant="danger" disabled={busy} onClick={() => { if (pending === 'close') skillSettingsStore.set(false); else void reload(); }}>放弃修改并{pending === 'close' ? '关闭' : '读取'}</Button>
    </> : <>
      <span className="ice-skills__status" role="status">{dirty ? '有未保存修改' : '设置按当前公众号保存'}</span>
      <Button variant="ghost" disabled={busy} onClick={() => { if (changed.current) setPending('reload'); else void reload(); }}>读取已保存设置</Button>
      <Button disabled={busy} onClick={close}>关闭</Button>
      <Button variant="primary" loading={busy} disabled={!draft || !hash || !dirty} onClick={() => void save()}>保存设置</Button>
    </>}>
    <div className="ice-skills">
      {error && <Banner tone="danger" title="技能尚未保存">{error}。当前输入保留。</Banner>}
      {query.error && !draft && <Banner tone="warning" title="读取技能失败">{query.error.message}<Button onClick={() => void query.refetch()}>重试读取</Button></Banner>}
      {!draft && !query.error && <SkeletonRows rows={5} />}
      {draft && <>
        <fieldset className="ice-skills__choices" disabled={busy}>
          <legend>本公众号使用的主技能</legend>
          <label><input type="radio" name="writing-skill" checked={draft.active_skill_id === null} onChange={() => change(value => ({ ...value, active_skill_id: null }))} />不使用额外技能</label>
          {draft.skills.filter(skill => !isAddon(skill)).map(skill => <div className="ice-skills__choice" key={skill.id}>
            <label><input type="radio" name="writing-skill" checked={draft.active_skill_id === skill.id} onChange={() => change(value => ({ ...value, active_skill_id: skill.id }))} />{skill.name || '未命名技能'} <small>v{skill.version}</small></label>
            <Button size="sm" variant={editing === skill.id ? 'secondary' : 'ghost'} aria-label={'编辑' + (skill.name || '未命名技能')} aria-pressed={editing === skill.id} onClick={() => { setEditing(skill.id); setHistory(false); }}>编辑</Button>
          </div>)}
          <div className="ice-skills__sub" role="group" aria-label="辅助技能">
            <strong>辅助技能</strong> <small>可叠加，最多 {MAX_ADDONS} 个；规则只补充主技能没有设置的部分</small>
            {draft.skills.filter(isAddon).map(skill => {
              const on = draft.active_addon_ids.includes(skill.id);
              return <div className="ice-skills__choice" key={skill.id}>
                <label><input type="checkbox" checked={on} disabled={!on && draft.active_addon_ids.length >= MAX_ADDONS}
                  onChange={() => change(value => ({ ...value, active_addon_ids: on ? value.active_addon_ids.filter(a => a !== skill.id) : [...value.active_addon_ids, skill.id] }))} />
                  {skill.name || '未命名技能'} <small>v{skill.version}</small></label>
                <Button size="sm" variant={editing === skill.id ? 'secondary' : 'ghost'} aria-label={'编辑' + (skill.name || '未命名技能')} aria-pressed={editing === skill.id} onClick={() => { setEditing(skill.id); setHistory(false); }}>编辑</Button>
              </div>;
            })}
            {!draft.skills.some(isAddon) && <small>还没有辅助技能。编辑某个技能，把“技能类型”改为辅助技能即可叠加使用（如标题策略、审阅清单）。</small>}
          </div>
          <ConflictCheck disabled={busy} skills={() => {
            // v3.20：检查编辑中的公众号组合（主技能 + 已勾选的辅助技能），未保存的修改也算
            const chosen = [draft.skills.find(s => s.id === draft.active_skill_id), ...draft.active_addon_ids.map(id => draft.skills.find(s => s.id === id))]
              .filter((s): s is DraftSkill => Boolean(s));
            if (!chosen.length) return '先选择主技能或勾选辅助技能';
            const out: CheckSkill[] = [];
            for (const s of chosen) {
              let rules: Record<string, unknown>;
              try { rules = JSON.parse(s.rulesText); } catch { return `「${s.name}」的检查规则不是有效 JSON`; }
              out.push({ id: s.id, name: s.name || '未命名技能', instructions: s.instructions, kind: s.kind, rules });
            }
            return out;
          }} />
          <Button size="sm" disabled={draft.skills.length >= 20} onClick={() => {
            const id = 'custom-' + crypto.randomUUID();
            change(value => ({ ...value, skills: [...value.skills, { id, name: '我的写作技能', instructions: '请按我的读者、文章目的和风格要求写作。', rulesText: '{}', version: 1 }] })); setEditing(id);
          }}>新建技能</Button>
          <div className="ice-skills__row">
            <ImportSkillButton disabled={busy || draft.skills.length >= 20} onImport={skill => addSkill('imported-' + crypto.randomUUID(), skill)} />
            <RestoreDefaultsButton disabled={busy} present={id => draft.skills.some(s => s.id === id)}
              onAdd={skill => { if (draft.skills.length < 20) addSkill(skill.id, skill); }}
              onReplace={skill => { edit(skill.id, { name: skill.name, instructions: skill.instructions, rulesText: JSON.stringify(skill.rules, null, 2), source: skill.source, files: undefined }); setEditing(skill.id); setHistory(false); }} />
          </div>
        </fieldset>
        {selected && <section className="ice-skills__editor" aria-label="编辑技能">
          <p className="ice-skills__note">编辑不会改变其他公众号。固定格式等硬性要求在检查规则中调整；品牌资料和事实核验独立保留。</p>
          <div className="ice-skills__row" role="group" aria-label="技能操作">
            <small>v{selected.version}{selected.source ? ` · ${sourceText(selected.source, id => draft.skills.find(s => s.id === id)?.name)}` : ''}</small>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" disabled={busy || draft.skills.length >= 20} onClick={() => {
              let rules: Record<string, unknown> = {};
              try { rules = JSON.parse(selected.rulesText); } catch { /* 规则 JSON 有误时复制为空规则，原技能不受影响 */ }
              addSkill('copy-' + crypto.randomUUID(), { name: selected.name + ' 副本', instructions: selected.instructions, rules, kind: selected.kind, files: selected.files,
                source: { kind: 'copy', from_skill_id: selected.id, from_version: selected.version } });
            }}>复制为新技能</Button>
            <Button size="sm" variant="ghost" disabled={busy || !savedSkill(selected.id)} title={savedSkill(selected.id) ? '导出上次保存的版本（Markdown，可再导入）' : '保存后才能导出'}
              onClick={() => { if (JSON.stringify(savedSkill(selected.id)) !== JSON.stringify(selected)) toast.info({ title: '导出的是上次保存的版本', detail: '编辑区里尚未保存的修改不包含在文件中。' }); void exportSkill(selected.id); }}>导出</Button>
            <Button size="sm" variant={history ? 'secondary' : 'ghost'} aria-pressed={history} disabled={busy} onClick={() => setHistory(value => !value)}>版本历史</Button>
          </div>
          {history && <SkillHistory skillId={selected.id} onClose={() => setHistory(false)} onLoad={detail => {
            edit(selected.id, { name: detail.name, instructions: detail.instructions, rulesText: JSON.stringify(detail.rules, null, 2),
              source: { kind: 'restore', from_version: detail.version }, files: detail.files?.length ? detail.files : undefined });
            setHistory(false);
            toast.info({ title: `已载入 v${detail.version}`, detail: '核对后点“保存设置”，会作为新版本保存。' });
          }} />}
          <label>技能名称<Input disabled={busy} maxLength={80} value={selected.name} onChange={event => edit(selected.id, { name: event.target.value })} /></label>
          <label>技能类型<select aria-label="技能类型" disabled={busy} value={isAddon(selected) ? 'addon' : 'main'} onChange={event => {
            const kind = event.target.value as 'main' | 'addon';
            change(value => ({ ...dropRefs(value, selected.id, kind === 'addon' ? 'main' : 'addon'),
              skills: value.skills.map(s => s.id === selected.id ? { ...s, kind } : s) }));
          }}>
            <option value="main">主技能：完整的写作方法，每篇只用一个</option>
            <option value="addon">辅助技能：可叠加的局部方法，如标题策略、审阅清单</option>
          </select></label>
          <label>写作指令<textarea aria-label="写作指令" disabled={busy} rows={10} maxLength={12000} value={selected.instructions} onChange={event => edit(selected.id, { instructions: event.target.value })} /></label>
          <SkillFiles files={selected.files ?? []} disabled={busy} onChange={files => edit(selected.id, { files: files.length ? files : undefined })} />
          <label>固定结尾标题（留空不要求）<Input disabled={busy || !parsed} maxLength={50} value={typeof parsed?.required_ending_heading === 'string' ? parsed.required_ending_heading : ''} onChange={event => updateRule('required_ending_heading', event.target.value)} /></label>
          <label className="ice-skills__check"><input type="checkbox" disabled={busy || !parsed} checked={parsed?.numbered_headings === true} onChange={event => updateRule('numbered_headings', event.target.checked)} />章节按中文数字编号</label>
          <details><summary>高级检查规则（JSON）</summary>
            <p className="ice-skills__note">支持标题长度、字数区间、代码数量/行数、结尾、编号、标点及禁用词。空对象表示不增加技能检查。</p>
            <label>检查规则 JSON<textarea aria-label="检查规则 JSON" disabled={busy} rows={14} maxLength={20000} spellCheck={false} value={selected.rulesText} onChange={event => edit(selected.id, { rulesText: event.target.value })} /></label>
            {!parsed && <p role="status">请修正 JSON 后再调整上方检查选项。</p>}
          </details>
          <Button variant="ghost" disabled={busy || draft.skills.length <= 1} onClick={() => {
            change(value => ({ ...dropRefs(value, selected.id, 'both'), skills: value.skills.filter(s => s.id !== selected.id) }));
            setEditing(draft.skills.find(s => s.id !== selected.id)?.id ?? '');
          }}>移除此技能（保存后生效）</Button>
        </section>}
        <div className="ice-skills__series">
          <Button size="sm" variant={seriesOpen ? 'secondary' : 'ghost'} aria-expanded={seriesOpen} disabled={busy} onClick={() => setSeriesOpen(value => !value)}>
            按系列设置（{Object.keys(draft.series_bindings).length}）</Button>
          {seriesOpen && <SeriesBindings draft={draft} disabled={busy} onChange={series_bindings => change(value => ({ ...value, series_bindings }))} />}
        </div>
      </>}
    </div>
  </Dialog>;
}

/** v3.16 按系列另选技能：未设置的部分沿用公众号；单篇文章还可以在编辑器里再改。 */
function SeriesBindings({ draft, disabled, onChange }: { draft: Draft; disabled: boolean; onChange: (next: Record<string, Binding>) => void }) {
  const docs = useAccountQuery<{ documents: Array<{ series: string | null }> }>('documents.list', { lifecycle: 'active', query: '', include_legacy: false }, { staleTime: 30_000, retry: false });
  const known: string[] = Array.from(new Set<string>((docs.data?.documents ?? []).map((d: { series: string | null }) => d.series ?? '').filter(Boolean)));
  const [name, setName] = React.useState('');
  const mains = draft.skills.filter(s => !isAddon(s)), addons = draft.skills.filter(isAddon);
  const entries = Object.entries(draft.series_bindings);
  const put = (series: string, binding: Binding | null) => {
    const next = { ...draft.series_bindings };
    if (binding && Object.keys(binding).length) next[series] = binding; else delete next[series];
    onChange(next);
  };
  return <div className="ice-skills__series-body">
    <p className="ice-skills__note">文章的“系列”在文章列表批量整理或文章设置里填写。这里只对新的生成和 AI 助手生效。</p>
    {entries.length === 0 && <p className="ice-skills__note">还没有按系列的设置。</p>}
    {entries.map(([series, binding]) => <div key={series} className="ice-skills__series-row" role="group" aria-label={`系列「${series}」的技能`}>
      <strong>{series}</strong>
      <select aria-label={`系列「${series}」的主技能`} disabled={disabled}
              value={!('main' in binding) ? '' : binding.main === null ? '__none__' : binding.main ?? ''}
              onChange={event => { const { main: _m, ...rest } = binding; void _m; const v = event.target.value;
                put(series, v === '' ? rest : { ...rest, main: v === '__none__' ? null : v }); }}>
        <option value="">主技能：沿用公众号</option>
        <option value="__none__">不使用主技能</option>
        {mains.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {addons.length > 0 && <label className="ice-skills__check"><input type="checkbox" disabled={disabled} checked={!('addons' in binding)}
        onChange={event => { const { addons: _a, ...rest } = binding; void _a; put(series, event.target.checked ? rest : { ...rest, addons: [] }); }} />辅助技能沿用公众号</label>}
      {'addons' in binding && addons.map(s => { const on = binding.addons!.includes(s.id);
        return <label key={s.id} className="ice-skills__check"><input type="checkbox" disabled={disabled || (!on && binding.addons!.length >= MAX_ADDONS)} checked={on}
          onChange={() => put(series, { ...binding, addons: on ? binding.addons!.filter(a => a !== s.id) : [...binding.addons!, s.id] })} />{s.name}</label>; })}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => put(series, null)}>删除此系列设置</Button>
    </div>)}
    <div className="ice-skills__row">
      <Input list="ice-skill-series" value={name} maxLength={40} placeholder="系列名，如：周刊" aria-label="新增系列名" disabled={disabled}
             onChange={event => setName(event.target.value)} style={{ maxWidth: 220 }} />
      <datalist id="ice-skill-series">{known.filter(s => !(s in draft.series_bindings)).map(s => <option key={s} value={s} />)}</datalist>
      <Button size="sm" disabled={disabled || !name.trim() || name.trim() in draft.series_bindings || entries.length >= 50}
              onClick={() => { put(name.trim(), { main: draft.active_skill_id }); setName(''); }}>添加系列</Button>
    </div>
  </div>;
}
