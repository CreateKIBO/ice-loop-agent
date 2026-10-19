"""Server-owned context for a new production job; raw queue payloads are not approvals."""
import copy


def production_spec(service, store, account_id, raw, *, preserve_demo=False):
    if not isinstance(raw,dict) or not raw:
        raise ValueError('生产任务需提供spec；缺少栏目、期号或主题时先向用户澄清')
    if raw.get('account_id') not in (None,account_id):
        raise ValueError('只能创建任务所属公众号的文章')
    account = service._account(account_id)
    spec = copy.deepcopy(raw)
    if not isinstance(spec.get('series'),str) or spec['series'] not in {column['code'] for column in account['columns']}:
        raise ValueError('请选择当前公众号的栏目')
    if type(spec.get('episode')) is not int or not 1 <= spec['episode'] <= 9999:
        raise ValueError('请先确认1–9999范围内的期号')
    if not isinstance(spec.get('topic'),str) or not 1 <= len(spec['topic'].strip()) <= 300:
        raise ValueError('请先确认不超过300字的文章主题')
    spec['topic'] = spec['topic'].strip()
    if spec.get('production_mode','review_each') not in ('review_each','auto_prepare'):
        raise ValueError('请选择逐步审阅或自动准备模式')
    execution = service.settings.get('execution',{'mode':'local_reviewed',
        'images':{'python':'python:3.12-slim','java':'eclipse-temurin:17-jdk'}})
    spec.update(account_id=account_id,account_snapshot=copy.deepcopy(account),article_root=account['article_root'],
        audience=account['audience'],target_words=copy.deepcopy(account['words_range']),
        demo=preserve_demo and raw.get('demo') is True,approve_local_exec=False,
        image_provider='manual_import',execution_mode=execution['mode'],container_images=copy.deepcopy(execution['images']))
    for key in ('publication_confirmation','article_history','title_selection','title_mode'):
        spec.pop(key,None)
    from ..publication_history import PublicationHistory
    spec['article_history'] = PublicationHistory(store,account).context(spec['series'],spec['episode'])
    return spec
