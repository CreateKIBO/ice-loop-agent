"""Account-owned, text-only writing skills. Settings never grant tool permissions."""
from __future__ import annotations

import copy
import json
import re

from .config import load_profile
from .domain.types import now_iso, sha256_json


GENERAL_INSTRUCTIONS = (
    "按读者、目的与本次要求组织文章。观点有依据，语言自然清晰，段落适合手机阅读。"
    "按需使用标题、列表和配图，不强制编程示例、练习、固定口号或下期预告。"
    "先确认关键事实，未核验的信息标明待核验；审阅时使用同一套有效规则。"
)
ICE_INSTRUCTIONS = (
    "采用 ICE Loop 的教学写作方法，读者与人设以当前公众号品牌为准。\n"
    "选题：给出不同角度，明确读者收益、标题承诺与证据要求，避免同义改写。\n"
    "骨架：章节循序渐进，技术词配大白话解释；标题承诺在前两章兑现。\n"
    "正文：句长以15–25字为参考，手机端单段尽量不超过5行；每段突出一个核心关键词。"
    "长短句交替，适当一句话独立成段，冷静、准确、有耐心。\n"
    "教学内容规划可独立运行的代码和关键注释，真实运行输出由系统回填。\n"
    "审阅：检查事实、标题兑现、逻辑衔接、语气与自然度；按下方检查规则核对编号、结尾与标点。"
)

INTEGER_RULES = {
    'title_max_chars': (1, 200), 'code_block_max_lines': (1, 200),
    'max_dash': (0, 10000), 'max_not_but_is_pattern': (0, 10000),
    'min_short_paragraphs': (0, 100),
}
RANGE_RULES = {'words_range': 10000, 'code_blocks': 30, 'key_comment_lines': 200}
TEXT_RULES = {'required_ending_heading': 50, 'brand_sentence_pattern': 500}
LIST_RULES = {'banned_ai_phrases', 'title_banned_words', 'curly_quotes', 'emotional_punctuation'}
BOOL_RULES = {'numbered_headings', 'require_sections', 'check_canned_patterns'}
RULE_KEYS = set(INTEGER_RULES) | set(RANGE_RULES) | set(TEXT_RULES) | LIST_RULES | BOOL_RULES | {'ending_triad', 'weekly_rules'}


def validate_rules(value: object) -> dict:
    if not isinstance(value, dict) or set(value) - RULE_KEYS:
        raise ValueError('技能检查规则包含不支持的字段')
    for key, item in value.items():
        if key in INTEGER_RULES:
            lo, hi = INTEGER_RULES[key]
            if type(item) is not int or not lo <= item <= hi:
                raise ValueError(f'{key} 需为 {lo}–{hi} 的整数')
        elif key in RANGE_RULES:
            if not isinstance(item, list) or len(item) != 2 or any(type(n) is not int for n in item) or not 0 <= item[0] <= item[1] <= RANGE_RULES[key]:
                raise ValueError(f'{key} 区间无效')
        elif key in TEXT_RULES:
            if not isinstance(item, str) or len(item) > TEXT_RULES[key]:
                raise ValueError(f'{key} 文本过长')
        elif key in BOOL_RULES:
            if type(item) is not bool:
                raise ValueError(f'{key} 需为布尔值')
        elif key in LIST_RULES:
            if not isinstance(item, list) or len(item) > 100 or any(not isinstance(n, str) or not 1 <= len(n) <= 60 for n in item):
                raise ValueError(f'{key} 需为最多100项、每项1–60字的文本列表')
        elif key == 'ending_triad':
            keys = {'ice_recap_keyword', 'preview_keyword', 'answer_promise_keyword', 'follow_keyword'}
            if not isinstance(item, dict) or set(item) - keys or any(not isinstance(n, str) or len(n) > 100 for n in item.values()):
                raise ValueError('ending_triad 仅支持结尾检查关键词')
        elif key == 'weekly_rules':
            if not isinstance(item, dict) or set(item) - {'zero_price_numbers', 'require_official_note', 'require_weekly_code_section'}:
                raise ValueError('weekly_rules 包含不支持的周刊检查')
            if 'zero_price_numbers' in item and type(item['zero_price_numbers']) is not bool:
                raise ValueError('zero_price_numbers 需为布尔值')
            if any(not isinstance(v, str) or len(v) > 100 for k, v in item.items() if k != 'zero_price_numbers'):
                raise ValueError('周刊检查关键词需为不超过100字的文本')
    return copy.deepcopy(value)


def default_settings(account: dict) -> dict:
    profile = load_profile()
    fields = set(INTEGER_RULES) | set(RANGE_RULES) | set(TEXT_RULES) | BOOL_RULES | {'ending_triad'}
    ice_rules = {key: copy.deepcopy(value) for key, value in profile['article'].items() if key in fields}
    ice_rules.update(banned_ai_phrases=profile['banned_ai_phrases'],
                     require_sections=True,
                     numbered_headings=profile['article'].get('numbered_headings', True),
                     check_canned_patterns=True,
                     weekly_rules=copy.deepcopy(profile.get('wk_extra_rules', {})),
                     curly_quotes=profile['banned_punctuation']['curly_quotes'],
                     emotional_punctuation=profile['banned_punctuation']['emotional'],
                     title_banned_words=['最全', '终极', '颠覆', '必看', '100%', '震惊'])
    # Brand-specific ending and words stay aligned with this account on first use.
    ice_rules.update(required_ending_heading=account.get('ending_heading', '写在最后'),
                     brand_sentence_pattern=account.get('closing_sentence', ''),
                     words_range=account.get('words_range', [1800, 2600]))
    return {'active_skill_id': 'ice-writing' if account.get('preset') == 'ice-loop' else 'general-writing',
            'skills': [
                {'id': 'general-writing', 'name': '通用写作', 'instructions': GENERAL_INSTRUCTIONS, 'rules': {}, 'version': 1},
                {'id': 'ice-writing', 'name': 'ICE 写作方法', 'instructions': ICE_INSTRUCTIONS, 'rules': ice_rules, 'version': 1},
            ]}


SOURCE_KINDS = {'import', 'copy', 'default', 'restore'}
SOURCE_KEYS = {'kind', 'file_name', 'sha256', 'format', 'imported_at', 'from_skill_id', 'from_version', 'original_version'}


def validate_source(value: object) -> dict | None:
    """v3.15 技能来源说明（导入文件、复制自哪一版、恢复自哪一版）。只做记录，不代表信任或授权。"""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - SOURCE_KEYS or value.get('kind') not in SOURCE_KINDS:
        raise ValueError('技能来源格式无效')
    for key, item in value.items():
        if key in ('from_version', 'original_version'):
            if type(item) is not int or not 0 < item < 1_000_000:
                raise ValueError('技能来源版本号无效')
        elif not isinstance(item, str) or len(item) > 200:
            raise ValueError('技能来源说明过长')
    return copy.deepcopy(value)


SKILL_KINDS = ('main', 'addon')
MAX_ADDONS = 5
MAX_SERIES_BINDINGS = 50
SCOPE_LABEL = {'document': '本篇', 'series': '系列', 'account': '公众号'}
_ID = re.compile(r'[a-zA-Z0-9_-]{1,80}')


def normalize_binding(value: object, where: str = '技能选择') -> dict | None:
    """v3.16 技能绑定的形状校验：{'main': id|None, 'addons': [id...]}，缺少的键表示沿用上一级。"""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {'main', 'addons'}:
        raise ValueError(f'{where}格式无效')
    out: dict = {}
    if 'main' in value:
        main = value['main']
        if main is not None and (not isinstance(main, str) or not _ID.fullmatch(main)):
            raise ValueError(f'{where}的主技能标识无效')
        out['main'] = main
    if 'addons' in value:
        addons = value['addons']
        if not isinstance(addons, list) or len(addons) > MAX_ADDONS or any(not isinstance(a, str) or not _ID.fullmatch(a) for a in addons) \
                or len(set(addons)) != len(addons):
            raise ValueError(f'{where}的辅助技能最多 {MAX_ADDONS} 个且不能重复')
        out['addons'] = list(addons)
    return out


def normalize_selection(value: object) -> dict | None:
    """生成/助手请求附带的技能选择：{'series': 系列名, 'binding': 绑定}。只校验形状；引用的技能不存在时解析回退上一级。"""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {'series', 'binding'}:
        raise ValueError('技能选择格式无效')
    series = value.get('series')
    if series is not None and (not isinstance(series, str) or len(series) > 40):
        raise ValueError('系列名无效')
    return {'series': series or None, 'binding': normalize_binding(value.get('binding'))}


def selection_for_document(store, account_id: str, document_id: str) -> dict | None:
    """普通文章的技能选择：本篇绑定（meta.skill_binding）与所属系列。"""
    row = store.conn.execute('SELECT series, meta_json FROM documents WHERE document_id=? AND account_id=?',
                             (document_id, account_id)).fetchone()
    if not row:
        return None
    meta = json.loads(row['meta_json'] or '{}')
    try:
        binding = normalize_binding(meta.get('skill_binding'))
    except ValueError:
        binding = None
    return {'series': row['series'] or None, 'binding': binding}


def skill_summary(snapshot: dict | None) -> list[dict]:
    """快照里实际使用的技能（名称/版本/角色），用于“本篇使用”显示，不含指令正文。"""
    if not snapshot:
        return []
    out = []
    if snapshot.get('skill'):
        out.append({'id': snapshot['skill']['id'], 'name': snapshot['skill']['name'], 'version': snapshot['skill'].get('version'), 'kind': 'main'})
    out += [{'id': a['id'], 'name': a['name'], 'version': a.get('version'), 'kind': 'addon'} for a in snapshot.get('addons') or []]
    return out


def _content_hash(skill: dict) -> str:
    return sha256_json({'name': skill['name'], 'instructions': skill['instructions'], 'rules': skill['rules']})


def merge_rules(main: dict | None, addons: list[dict]) -> tuple[dict, list[dict]]:
    """主技能规则优先；辅助技能只补充主技能没有设置的规则。值不同的同名规则记为冲突（按顺序先到先得），不静默覆盖。"""
    rules = copy.deepcopy(main['rules']) if main else {}
    owner = {key: main['id'] for key in rules} if main else {}
    conflicts = []
    for addon in addons:
        for key, value in addon['rules'].items():
            if key not in rules:
                rules[key], owner[key] = copy.deepcopy(value), addon['id']
            elif rules[key] != value:
                conflicts.append({'rule': key, 'kept': owner[key], 'ignored': addon['id'],
                                  'kind': 'main' if main and owner[key] == main['id'] else 'addon'})
    return rules, conflicts


class WritingSkills:
    def __init__(self, store, account: dict):
        self.store, self.account = store, account

    def get(self) -> dict:
        row = self.store.conn.execute(
            'SELECT revision,settings_json FROM writing_skill_settings WHERE account_id=?',
            (self.account['id'],)).fetchone()
        state = json.loads(row[1]) if row else default_settings(self.account)
        # v3.16：辅助技能与系列绑定；旧数据缺少时按“没有”处理。
        state.setdefault('active_addon_ids', [])
        state.setdefault('series_bindings', {})
        for skill in state['skills']:
            skill.setdefault('kind', 'main')
        result = {**state, 'account_id': self.account['id'], 'revision': row[0] if row else 0}
        return {**result, 'state_hash': sha256_json(result)}

    def save(self, params: dict) -> dict:
        if params.get('account_id') != self.account['id']:
            raise ValueError('公众号已切换，请重新打开技能设置')
        if 'active_skill_id' not in params:
            raise ValueError('请明确选择主技能，或不使用额外技能')
        skills = params.get('skills')
        if not isinstance(skills, list) or not 1 <= len(skills) <= 20:
            raise ValueError('请保留1–20个写作技能')
        cleaned, ids = [], set()
        for item in skills:
            if not isinstance(item, dict) or set(item) - {'id', 'name', 'instructions', 'rules', 'version', 'source', 'kind'}:
                raise ValueError('技能格式无效')
            sid, name, instructions = item.get('id'), item.get('name'), item.get('instructions')
            if not isinstance(sid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', sid) or sid in ids:
                raise ValueError('技能标识无效或重复')
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                raise ValueError('技能名称需为1–80字')
            if not isinstance(instructions, str) or not 1 <= len(instructions.strip()) <= 12000:
                raise ValueError('技能指令需为1–12000字')
            ids.add(sid)
            kind = item.get('kind', 'main')
            if kind not in SKILL_KINDS:
                raise ValueError('技能类型需为主技能或辅助技能')
            entry = {'id': sid, 'name': name.strip(), 'instructions': instructions.strip(),
                     'rules': validate_rules(item.get('rules', {})), 'kind': kind}
            source = validate_source(item.get('source'))
            if source:
                entry['source'] = source
            cleaned.append(entry)
        if sum(len(s['instructions']) for s in cleaned) > 60000:
            raise ValueError('技能指令总长度不能超过60000字')
        selected = params.get('active_skill_id')
        kinds = {s['id']: s['kind'] for s in cleaned}
        if selected is not None and (not isinstance(selected, str) or selected not in ids):
            raise ValueError('请选择存在的技能，或不使用额外技能')
        if selected is not None and kinds[selected] != 'main':
            raise ValueError('辅助技能不能作为主技能；请在“辅助技能”里勾选')
        with self.store.transaction():
            current = self.get()
            if params.get('state_hash') != current['state_hash']:
                raise ValueError('技能已在其他窗口修改，请重新读取并核对；当前输入保留')
            addons, series_bindings = self._bindings(params, current, cleaned)
            previous = {s['id']: s for s in current['skills']}
            # v3.15：改动前的版本先补进历史（旧数据或预装技能第一次被改时），再记录新版本。
            for old in current['skills']:
                self._record(old)
            for skill in cleaned:
                old = previous.get(skill['id'])
                changed = not old or any(old[k] != skill[k] for k in ('name', 'instructions', 'rules'))
                if old:
                    skill['version'] = old['version'] + int(changed)
                else:  # 新建，或移除后重新加入同一标识：接着历史版本号往下编
                    skill['version'] = self._latest_version(skill['id']) + 1
                if changed:
                    self._record(skill)
            state = {'active_skill_id': selected, 'active_addon_ids': addons, 'series_bindings': series_bindings, 'skills': cleaned}
            self.store.conn.execute(
                'INSERT INTO writing_skill_settings(account_id,revision,settings_json,updated_at) VALUES(?,?,?,?) '
                'ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,updated_at=excluded.updated_at',
                (self.account['id'], current['revision'] + 1, json.dumps(state, ensure_ascii=False), now_iso()))
        return self.get()

    # ------------------------------------------------------------ v3.16 组合与作用域
    def _bindings(self, params: dict, current: dict, cleaned: list[dict]) -> tuple[list[str], dict]:
        """公众号辅助技能与系列绑定。显式传入的必须引用存在且类型正确的技能；
        未传入的沿用已保存设置，并去掉已移除的技能（卸载移除未来绑定）。"""
        kinds = {s['id']: s['kind'] for s in cleaned}

        def check(binding: dict | None, where: str, strict: bool) -> dict | None:
            if binding is None:
                return None
            out = dict(binding)
            if out.get('main') is not None and kinds.get(out['main']) != 'main':
                if strict:
                    raise ValueError(f'{where}的主技能不存在或不是主技能')
                out.pop('main')
            if 'addons' in out:
                bad = [a for a in out['addons'] if kinds.get(a) != 'addon']
                if bad and strict:
                    raise ValueError(f'{where}的辅助技能不存在或不是辅助技能')
                out['addons'] = [a for a in out['addons'] if a not in bad]
            return out

        strict = 'active_addon_ids' in params
        raw = params['active_addon_ids'] if strict else current.get('active_addon_ids', [])
        addons = check(normalize_binding({'addons': raw}, '公众号辅助技能'), '公众号辅助技能', strict)['addons']
        strict = 'series_bindings' in params
        raw_series = params['series_bindings'] if strict else current.get('series_bindings', {})
        if not isinstance(raw_series, dict) or len(raw_series) > MAX_SERIES_BINDINGS:
            raise ValueError(f'系列绑定最多 {MAX_SERIES_BINDINGS} 个')
        series: dict = {}
        for name, binding in raw_series.items():
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
                raise ValueError('系列名需为1–40字')
            value = check(normalize_binding(binding, f'系列「{name}」'), f'系列「{name}」', strict)
            if value:
                series[name.strip()] = value
        skills = {s['id']: s for s in cleaned}
        for where, chosen in [('公众号', addons)] + [(f'系列「{n}」', b['addons']) for n, b in series.items() if 'addons' in b]:
            conflicts = [c for c in merge_rules(None, [skills[a] for a in chosen])[1] if c['kind'] == 'addon']
            if conflicts:
                c = conflicts[0]
                raise ValueError(f'{where}同时启用的「{skills[c["kept"]]["name"]}」和「{skills[c["ignored"]]["name"]}」'
                                 f'对检查规则 {c["rule"]} 的要求不同，请只保留一个或修改其中一个')
        return addons, series

    def resolve(self, selection: dict | None = None, state: dict | None = None) -> dict:
        """按“本篇 → 系列 → 公众号”解析实际生效的主技能与辅助技能。
        引用的技能已被移除时回退上一级，并在 notices 里说明。"""
        state = state or self.get()
        selection = normalize_selection(selection) or {'series': None, 'binding': None}
        skills = {s['id']: s for s in state['skills']}
        series = selection['series']
        layers = [('document', selection['binding']),
                  ('series', state.get('series_bindings', {}).get(series) if series else None),
                  ('account', {'main': state['active_skill_id'], 'addons': state.get('active_addon_ids', [])})]
        notices: list[str] = []
        main, main_scope = None, 'account'
        for scope, binding in layers:
            if not binding or 'main' not in binding:
                continue
            if binding['main'] is None:
                main, main_scope = None, scope
                break
            found = skills.get(binding['main'])
            if found and found.get('kind', 'main') == 'main':
                main, main_scope = found, scope
                break
            notices.append(f'{SCOPE_LABEL[scope]}指定的主技能已移除，改用上一级设置')
        addons, addon_scope = [], 'account'
        for scope, binding in layers:
            if not binding or 'addons' not in binding:
                continue
            addons = [skills[a] for a in binding['addons'] if skills.get(a, {}).get('kind') == 'addon']
            if len(addons) < len(binding['addons']):
                notices.append(f'{SCOPE_LABEL[scope]}指定的部分辅助技能已移除')
            addon_scope = scope
            break
        rules, conflicts = merge_rules(main, addons)
        return {'main': main, 'addons': addons, 'scope': {'main': main_scope, 'addons': addon_scope},
                'rules': rules, 'conflicts': conflicts, 'notices': notices, 'state': state}

    def resolve_preview(self, params: dict) -> dict:
        """skills.resolve：给界面看的解析结果（不含指令全文）。可传 document_id，或 series 与 binding。"""
        self._check_account(params)
        if params.get('document_id'):
            selection = selection_for_document(self.store, self.account['id'], str(params['document_id']))
            if selection is None:
                raise ValueError('当前公众号没有这篇文章')
            if 'binding' in params:  # 预览尚未保存的本篇选择
                selection['binding'] = normalize_binding(params['binding'])
        else:
            selection = {'series': params.get('series'), 'binding': params.get('binding')}
        result = self.resolve(selection)
        brief = lambda s: {'id': s['id'], 'name': s['name'], 'version': s['version'], 'kind': s.get('kind', 'main')}
        names = {s['id']: s['name'] for s in result['state']['skills']}
        return {'main': brief(result['main']) if result['main'] else None, 'addons': [brief(a) for a in result['addons']],
                'scope': result['scope'], 'rule_count': len(result['rules']),
                'conflicts': [{**c, 'kept_name': names.get(c['kept'], c['kept']), 'ignored_name': names.get(c['ignored'], c['ignored'])}
                              for c in result['conflicts']],
                'notices': result['notices'], 'series': (selection or {}).get('series'),
                'binding': (selection or {}).get('binding')}

    def validate_binding(self, value: object) -> dict | None:
        """本篇绑定：引用的技能必须存在且类型正确；辅助技能之间的规则冲突直接拒绝。"""
        binding = normalize_binding(value, '本篇技能')
        if not binding:
            return None
        state = self.get()
        skills = {s['id']: s for s in state['skills']}
        main = binding.get('main')
        if main is not None and (main not in skills or skills[main].get('kind', 'main') != 'main'):
            raise ValueError('本篇选择的主技能不存在')
        if any(skills.get(a, {}).get('kind') != 'addon' for a in binding.get('addons', [])):
            raise ValueError('本篇选择的辅助技能不存在')
        conflicts = [c for c in merge_rules(None, [skills[a] for a in binding.get('addons', [])])[1] if c['kind'] == 'addon']
        if conflicts:
            c = conflicts[0]
            raise ValueError(f'「{skills[c["kept"]]["name"]}」和「{skills[c["ignored"]]["name"]}」对检查规则 {c["rule"]} 的要求不同，请只选其中一个')
        return binding

    # ------------------------------------------------------------ v3.15 版本历史
    def _latest_version(self, skill_id: str) -> int:
        row = self.store.conn.execute('SELECT MAX(version) FROM writing_skill_versions WHERE account_id=? AND skill_id=?',
                                      (self.account['id'], skill_id)).fetchone()
        return int(row[0] or 0)

    def _record(self, skill: dict) -> None:
        self.store.conn.execute(
            'INSERT OR IGNORE INTO writing_skill_versions(account_id,skill_id,version,name,instructions,rules_json,content_hash,source_json,created_at)'
            ' VALUES (?,?,?,?,?,?,?,?,?)',
            (self.account['id'], skill['id'], int(skill['version']), skill['name'], skill['instructions'],
             json.dumps(skill['rules'], ensure_ascii=False), _content_hash(skill),
             json.dumps(skill.get('source') or {}, ensure_ascii=False), now_iso()))

    def _check_account(self, params: dict) -> None:
        if params.get('account_id', self.account['id']) != self.account['id']:
            raise ValueError('公众号已切换，请重新打开技能设置')

    @staticmethod
    def _skill_id(params: dict) -> str:
        sid = params.get('skill_id')
        if not isinstance(sid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', sid):
            raise ValueError('技能标识无效')
        return sid

    def versions(self, params: dict) -> dict:
        """某个技能的版本列表（新到旧）。当前在用、尚未写入历史的版本也列出。"""
        self._check_account(params)
        sid = self._skill_id(params)
        state = self.get()
        current = next((s for s in state['skills'] if s['id'] == sid), None)
        rows = [dict(r) for r in self.store.conn.execute(
            'SELECT version,name,instructions,rules_json,content_hash,source_json,created_at FROM writing_skill_versions'
            ' WHERE account_id=? AND skill_id=? ORDER BY version DESC', (self.account['id'], sid))]
        items = [{'version': r['version'], 'name': r['name'], 'chars': len(r['instructions']),
                  'rule_count': len(json.loads(r['rules_json'])), 'content_hash': r['content_hash'],
                  'source': json.loads(r['source_json']) or None, 'created_at': r['created_at'],
                  'current': bool(current and current['version'] == r['version'])} for r in rows]
        if current and not any(i['current'] for i in items):
            items.insert(0, {'version': current['version'], 'name': current['name'], 'chars': len(current['instructions']),
                             'rule_count': len(current['rules']), 'content_hash': _content_hash(current),
                             'source': current.get('source'), 'created_at': None, 'current': True})
        if not items:
            raise ValueError('没有这个技能的记录')
        return {'skill_id': sid, 'installed': current is not None, 'versions': items}

    def version(self, params: dict) -> dict:
        self._check_account(params)
        sid = self._skill_id(params)
        number = params.get('version')
        if type(number) is not int:
            raise ValueError('请指定版本号')
        row = self.store.conn.execute(
            'SELECT * FROM writing_skill_versions WHERE account_id=? AND skill_id=? AND version=?',
            (self.account['id'], sid, number)).fetchone()
        if row:
            return {'skill_id': sid, 'version': number, 'name': row['name'], 'instructions': row['instructions'],
                    'rules': json.loads(row['rules_json']), 'source': json.loads(row['source_json']) or None,
                    'created_at': row['created_at']}
        current = next((s for s in self.get()['skills'] if s['id'] == sid and s['version'] == number), None)
        if not current:
            raise ValueError('没有这个版本')
        return {'skill_id': sid, 'version': number, 'name': current['name'], 'instructions': current['instructions'],
                'rules': copy.deepcopy(current['rules']), 'source': current.get('source'), 'created_at': None}

    def defaults(self, params: dict) -> dict:
        """预装技能的原始内容：用户主动“恢复预装”时读取，不自动覆盖个人修改。"""
        self._check_account(params)
        return {'skills': [{k: v for k, v in s.items() if k != 'version'} for s in default_settings(self.account)['skills']]}

    def export(self, params: dict) -> dict:
        from .skill_packages import to_markdown
        if 'version' in params:
            item = self.version(params)
            kind = next((x.get('kind', 'main') for x in self.get()['skills'] if x['id'] == item['skill_id']), 'main')
            return to_markdown({**item, 'id': item['skill_id'], 'kind': kind}, version=item['version'])
        self._check_account(params)
        sid = self._skill_id(params)
        current = next((s for s in self.get()['skills'] if s['id'] == sid), None)
        if not current:
            raise ValueError('没有这个技能')
        return to_markdown(current)

    def apply(self, profile: dict, selection: dict | None = None) -> dict:
        result = copy.deepcopy(profile)
        resolved = self.resolve(selection)
        state, selected = resolved['state'], resolved['main']
        # Neutral method baseline. Keep account identity, factual checks, assets,
        # budgets and permissions; remove inherited author-specific style gates.
        result['article'].update(required_ending_heading='', brand_sentence_pattern='', ending_triad={},
                                 numbered_headings=False, require_sections=False, code_blocks=[0, 30],
                                 code_block_max_lines=200, key_comment_lines=[0, 200], max_dash=10000,
                                 max_not_but_is_pattern=10000, min_short_paragraphs=0)
        result.update(banned_ai_phrases=[], banned_patterns=[], title_banned_words=[], wk_extra_rules={})
        result['banned_punctuation'] = {'dash': '——', 'curly_quotes': [], 'emotional': []}
        rules = resolved['rules']  # v3.16：主技能规则 + 辅助技能补充的规则
        for key, value in rules.items():
            if key == 'check_canned_patterns':
                result['banned_patterns'] = copy.deepcopy(load_profile()['banned_patterns']) if value else []
            elif key == 'weekly_rules':
                result['wk_extra_rules'] = copy.deepcopy(value)
            elif key in {'banned_ai_phrases', 'title_banned_words'}:
                result[key] = copy.deepcopy(value)
            elif key in {'curly_quotes', 'emotional_punctuation'}:
                result['banned_punctuation']['curly_quotes' if key == 'curly_quotes' else 'emotional'] = copy.deepcopy(value)
            else:
                result['article'][key] = copy.deepcopy(value)
        snapshot = {'account_id': self.account['id'], 'settings_revision': state['revision'],
                    'skill': copy.deepcopy(selected), 'state_hash': state['state_hash']}
        if resolved['addons']:
            snapshot['addons'] = copy.deepcopy(resolved['addons'])
        if selection:  # 生成/助手请求带了本篇或系列选择：记下作用域与解析说明
            snapshot['scope'] = resolved['scope']
        if resolved['conflicts']:
            snapshot['conflicts'] = resolved['conflicts']
        if resolved['notices']:
            snapshot['notices'] = resolved['notices']
        result['writing_skill_snapshot'] = snapshot
        return result
