import * as React from 'react';
import { Banner, Button, Dialog, Input, SkeletonRows } from '../../components/ui';
import { toast } from '../../components/toast';
import { accountStore, dirtyStore, queryClient, registerDirtyFlush, rpc, useAccountQuery, useCurrentAccount } from '../../data/client';
import { skillSettingsStore } from '../../app/uiState';
import '../../styles/skills.css';

type Skill = { id: string; name: string; instructions: string; rules: Record<string, unknown>; version: number };
type Snapshot = { account_id: string; revision: number; state_hash: string; active_skill_id: string | null; skills: Skill[] };
type DraftSkill = Omit<Skill, 'rules'> & { rulesText: string };
type Draft = { active_skill_id: string | null; skills: DraftSkill[] };

function toDraft(state: Snapshot): Draft {
  return { active_skill_id: state.active_skill_id, skills: state.skills.map(({ rules, ...skill }) => ({ ...skill, rulesText: JSON.stringify(rules, null, 2) })) };
}

export function SkillSettings() {
  const account = useCurrentAccount();
  const query = useAccountQuery<Snapshot>('skills.get', {}, { staleTime: 0, refetchOnMount: 'always' });
  const [draft, setDraft] = React.useState<Draft | null>(null), [base, setBase] = React.useState(''), [hash, setHash] = React.useState('');
  const [editing, setEditing] = React.useState(''), [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<'close' | 'reload' | null>(null);
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
      const result = await rpc<Snapshot>('skills.save', { account_id: account, state_hash: hash, skills, active_skill_id: draft.active_skill_id });
      if (!current()) return;
      install(result);
      queryClient.setQueryData(['ice', account, 'skills.get', {}], result);
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
    description="为当前公众号选择一个主写作技能，或编辑自己的方法。技能只影响写作与检查，不授予工具或发布权限。"
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
          {draft.skills.map(skill => <div className="ice-skills__choice" key={skill.id}>
            <label><input type="radio" name="writing-skill" checked={draft.active_skill_id === skill.id} onChange={() => change(value => ({ ...value, active_skill_id: skill.id }))} />{skill.name || '未命名技能'} <small>v{skill.version}</small></label>
            <Button size="sm" variant={editing === skill.id ? 'secondary' : 'ghost'} aria-label={'编辑' + (skill.name || '未命名技能')} aria-pressed={editing === skill.id} onClick={() => setEditing(skill.id)}>编辑</Button>
          </div>)}
          <Button size="sm" disabled={draft.skills.length >= 20} onClick={() => {
            const id = 'custom-' + crypto.randomUUID();
            change(value => ({ ...value, skills: [...value.skills, { id, name: '我的写作技能', instructions: '请按我的读者、文章目的和风格要求写作。', rulesText: '{}', version: 1 }] })); setEditing(id);
          }}>新建技能</Button>
        </fieldset>
        {selected && <section className="ice-skills__editor" aria-label="编辑技能">
          <p className="ice-skills__note">编辑不会改变其他公众号。固定格式等硬性要求在检查规则中调整；品牌资料和事实核验独立保留。</p>
          <label>技能名称<Input disabled={busy} maxLength={80} value={selected.name} onChange={event => edit(selected.id, { name: event.target.value })} /></label>
          <label>写作指令<textarea aria-label="写作指令" disabled={busy} rows={10} maxLength={12000} value={selected.instructions} onChange={event => edit(selected.id, { instructions: event.target.value })} /></label>
          <label>固定结尾标题（留空不要求）<Input disabled={busy || !parsed} maxLength={50} value={typeof parsed?.required_ending_heading === 'string' ? parsed.required_ending_heading : ''} onChange={event => updateRule('required_ending_heading', event.target.value)} /></label>
          <label className="ice-skills__check"><input type="checkbox" disabled={busy || !parsed} checked={parsed?.numbered_headings === true} onChange={event => updateRule('numbered_headings', event.target.checked)} />章节按中文数字编号</label>
          <details><summary>高级检查规则（JSON）</summary>
            <p className="ice-skills__note">支持标题长度、字数区间、代码数量/行数、结尾、编号、标点及禁用词。空对象表示不增加技能检查。</p>
            <label>检查规则 JSON<textarea aria-label="检查规则 JSON" disabled={busy} rows={14} maxLength={20000} spellCheck={false} value={selected.rulesText} onChange={event => edit(selected.id, { rulesText: event.target.value })} /></label>
            {!parsed && <p role="status">请修正 JSON 后再调整上方检查选项。</p>}
          </details>
          <Button variant="ghost" disabled={busy || draft.skills.length <= 1} onClick={() => {
            change(value => ({ ...value, active_skill_id: value.active_skill_id === selected.id ? null : value.active_skill_id, skills: value.skills.filter(s => s.id !== selected.id) }));
            setEditing(draft.skills.find(s => s.id !== selected.id)?.id ?? '');
          }}>移除此技能（保存后生效）</Button>
        </section>}
      </>}
    </div>
  </Dialog>;
}
