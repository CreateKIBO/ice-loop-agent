"""Visible, bounded model-call limits; image-only scope cannot become a writer."""
import copy
import json

from .domain.types import now_iso, sha256_json
from .paths import atomic_write_text


def image_only(job):
    return job['workflow'] == 'supplement_images_v1'


def validate_limit(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise ValueError('模型调用上限需为1–100次的整数')
    return value


def used_calls(store, job_id):
    return store.conn.execute("SELECT COUNT(*) FROM model_invocations WHERE job_id=? "
        "AND status != 'MODEL_CAPABILITY_MISMATCH'", (job_id,)).fetchone()[0]


# 会话预算的默认值。settings 里没有 max_chat_calls 时按此展示与执行；
# 0 是显式关闭限制，不能把"没配置"误读成 0。
DEFAULT_CHAT_CALLS = 24


def chat_budget(settings) -> int:
    raw = settings.get('max_chat_calls', DEFAULT_CHAT_CALLS)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0 or raw > 1000:
        raise ValueError('会话模型调用上限需为 0–1000 的整数（0 表示不限制）')
    return raw


class ModelBudgets:
    def __init__(self, service):
        self.s = service

    def check_account(self, params):
        if params.get('account_id') is not None and params['account_id'] != self.s._account()['id']:
            raise ValueError('公众号已切换，请重新打开预算设置')

    def get(self, params):
        self.check_account(params)
        chat_limit = chat_budget(self.s.settings)
        result = {'max_model_calls': self.s.settings['max_model_calls'],
                  'max_image_model_calls': self.s.settings.get('max_image_model_calls', 12),
                  'max_chat_calls': chat_limit,
                  'chat_unlimited': chat_limit == 0,
                  'chat_configured': 'max_chat_calls' in self.s.settings}
        if params.get('job_id'):
            _, _, store = self.s._job_app(params['job_id'])
            try:
                job = store.get_job(params['job_id'])
                key = 'max_image_model_calls' if image_only(job) else 'max_model_calls'
                maximum = job['limits'].get(key, result['max_image_model_calls'] if image_only(job) else 20)
                used = used_calls(store, job['job_id'])
                result['job'] = {'job_id':job['job_id'], 'image_only':image_only(job),
                    'limit':maximum, 'used':used, 'remaining':max(0, maximum-used),
                    'limits_hash':sha256_json(job['limits']),
                    'legacy_budget':image_only(job) and key not in job['limits']}
            finally:
                store.close()
        if params.get('conversation_id'):
            conversation_id = str(params['conversation_id'])
            _, _, store = self.s._app()
            try:
                row = store.conn.execute(
                    "SELECT id FROM creative_conversations WHERE id=? AND account_id=?",
                    (conversation_id, self.s._account()['id'])).fetchone()
                if not row:
                    raise ValueError('会话不存在或不属于当前公众号')
                used = store.conversation_invocation_count(conversation_id)
                result['conversation'] = {
                    'conversation_id': conversation_id, 'limit': chat_limit,
                    'unlimited': chat_limit == 0, 'used': used,
                    'remaining': None if chat_limit == 0 else max(0, chat_limit - used)}
            finally:
                store.close()
        return result

    def ensure_image_budget(self, store, job):
        if not image_only(job) or 'max_image_model_calls' in job['limits']:
            return
        maximum = validate_limit(self.s.settings.get('max_image_model_calls', 12))
        with store.transaction():
            current = store.get_job(job['job_id'])
            if 'max_image_model_calls' in current['limits']:
                return
            limits = {**current['limits'], 'max_image_model_calls':maximum}
            store.conn.execute('UPDATE jobs SET limits_json=?,updated_at=? WHERE job_id=?',
                               (json.dumps(limits), now_iso(), job['job_id']))

    def save(self, params):
        self.check_account(params)
        if params.get('scope') == 'defaults':
            normal = validate_limit(params.get('max_model_calls'))
            images = validate_limit(params.get('max_image_model_calls'))
            chat = chat_budget({'max_chat_calls': params.get('max_chat_calls', DEFAULT_CHAT_CALLS)})
            with self.s._settings_guard:
                self.check_account(params)
                updated = copy.deepcopy(self.s.settings)
                updated.update(max_model_calls=normal, max_image_model_calls=images,
                               max_chat_calls=chat)
                atomic_write_text(self.s.settings_file, json.dumps(updated, ensure_ascii=False, indent=2))
                self.s.settings = updated
            return self.get({'account_id':params.get('account_id')})
        if params.get('scope') != 'job' or not params.get('job_id'):
            raise ValueError('请选择默认预算或当前文章预算')
        maximum = validate_limit(params.get('limit'))
        _, _, store = self.s._job_app(params['job_id'])
        try:
            with store.transaction():
                self.check_account(params)
                job = store.get_job(params['job_id'])
                future = self.s.running.get(job['job_id'])
                if job['lease'] or future and not future.done():
                    raise ValueError('任务正在运行，请等待请求结束后调整预算')
                if params.get('limits_hash') != sha256_json(job['limits']):
                    raise ValueError('本篇预算已变化，请刷新后再保存')
                used = used_calls(store, job['job_id'])
                if maximum < used:
                    raise ValueError(f'已调用{used}次，上限不能低于已用次数')
                key = 'max_image_model_calls' if image_only(job) else 'max_model_calls'
                limits = {**job['limits'], key:maximum}
                store.conn.execute('UPDATE jobs SET limits_json=?,updated_at=? WHERE job_id=?',
                                   (json.dumps(limits), now_iso(), job['job_id']))
            return self.get(params)
        finally:
            store.close()
