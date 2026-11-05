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


class WritingSkills:
    def __init__(self, store, account: dict):
        self.store, self.account = store, account

    def get(self) -> dict:
        row = self.store.conn.execute(
            'SELECT revision,settings_json FROM writing_skill_settings WHERE account_id=?',
            (self.account['id'],)).fetchone()
        state = json.loads(row[1]) if row else default_settings(self.account)
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
            if not isinstance(item, dict) or set(item) - {'id', 'name', 'instructions', 'rules', 'version'}:
                raise ValueError('技能格式无效')
            sid, name, instructions = item.get('id'), item.get('name'), item.get('instructions')
            if not isinstance(sid, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', sid) or sid in ids:
                raise ValueError('技能标识无效或重复')
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                raise ValueError('技能名称需为1–80字')
            if not isinstance(instructions, str) or not 1 <= len(instructions.strip()) <= 12000:
                raise ValueError('技能指令需为1–12000字')
            ids.add(sid)
            cleaned.append({'id': sid, 'name': name.strip(), 'instructions': instructions.strip(),
                            'rules': validate_rules(item.get('rules', {}))})
        if sum(len(s['instructions']) for s in cleaned) > 60000:
            raise ValueError('技能指令总长度不能超过60000字')
        selected = params.get('active_skill_id')
        if selected is not None and (not isinstance(selected, str) or selected not in ids):
            raise ValueError('请选择存在的技能，或不使用额外技能')
        with self.store.transaction():
            current = self.get()
            if params.get('state_hash') != current['state_hash']:
                raise ValueError('技能已在其他窗口修改，请重新读取并核对；当前输入保留')
            previous = {s['id']: s for s in current['skills']}
            for skill in cleaned:
                old = previous.get(skill['id'])
                changed = not old or any(old[k] != skill[k] for k in ('name', 'instructions', 'rules'))
                skill['version'] = (old['version'] + int(changed)) if old else 1
            state = {'active_skill_id': selected, 'skills': cleaned}
            self.store.conn.execute(
                'INSERT INTO writing_skill_settings(account_id,revision,settings_json,updated_at) VALUES(?,?,?,?) '
                'ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,updated_at=excluded.updated_at',
                (self.account['id'], current['revision'] + 1, json.dumps(state, ensure_ascii=False), now_iso()))
        return self.get()

    def apply(self, profile: dict) -> dict:
        result = copy.deepcopy(profile)
        state = self.get()
        selected = next((s for s in state['skills'] if s['id'] == state['active_skill_id']), None)
        # Neutral method baseline. Keep account identity, factual checks, assets,
        # budgets and permissions; remove inherited author-specific style gates.
        result['article'].update(required_ending_heading='', brand_sentence_pattern='', ending_triad={},
                                 numbered_headings=False, require_sections=False, code_blocks=[0, 30],
                                 code_block_max_lines=200, key_comment_lines=[0, 200], max_dash=10000,
                                 max_not_but_is_pattern=10000, min_short_paragraphs=0)
        result.update(banned_ai_phrases=[], banned_patterns=[], title_banned_words=[], wk_extra_rules={})
        result['banned_punctuation'] = {'dash': '——', 'curly_quotes': [], 'emotional': []}
        rules = selected['rules'] if selected else {}
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
        result['writing_skill_snapshot'] = {'account_id': self.account['id'], 'settings_revision': state['revision'],
                                             'skill': copy.deepcopy(selected), 'state_hash': state['state_hash']}
        return result
