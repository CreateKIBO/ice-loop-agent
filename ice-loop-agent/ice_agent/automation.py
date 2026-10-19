"""Opt-in editorial decisions, always recorded through the ordinary review gates."""

SCOPES = {'topic','outline','final_title','asset_plan'}


def delivery_hash(state: dict, slots: list) -> str:
    from .domain.types import sha256_json
    return sha256_json({'body':state.get('integrated_md',state.get('draft_md','')),
        'title':state.get('final_title',''),
        'images':[(s['slot_id'],s.get('selected_candidate')) for s in slots],
        'run_evidence':{key:{field:record.get(field) for field in
            ('code_sha256','stdin_hash','output_sha256','verdict','exit_code','timed_out','expected_failure')}
            for key,record in (state.get('runs') or {}).items()}})


def editorial_decision(scope: str, payload: dict):
    if scope not in SCOPES:
        raise ValueError('此审核不属于自动内容准备范围')
    candidates=payload.get('candidates',payload.get('directions',[]))
    choice=None
    if candidates:
        choice=payload.get('recommended',0)
        if type(choice) is not int or not 0<=choice<len(candidates):
            raise ValueError('AI推荐的候选序号无效，请人工审阅')
    return 'approve','用户选择自动准备模式；按模型推荐自动选定，完成后统一人工审阅。',choice
