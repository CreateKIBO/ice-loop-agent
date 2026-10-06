"""角色路由与回退（§9.8 / §9.10 / §9.14）。

- 每个角色（planner/researcher/writer/reviewer/title_editor/…）绑定
  primary + fallbacks profile；任务创建时保存配置快照；
- required_off / required_on 是硬约束：候选先过能力过滤，
  无合格候选返回 MODEL_CAPABILITY_MISMATCH，不自动降低条件；
- 回退生成「完整候选」不与旧候选拼接；已执行工具不重放；
- 每次调用独立记录 model_invocations（含 usage_unknown）。
"""
from __future__ import annotations

import json
import base64
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from ..domain.store import Store
from ..domain.types import ModelProfile, new_id, sha256_text, sha256_json
from .adapters import extract_json_block, make_adapter
from .errors import ModelError, SchemaInvalidError, IncompleteResponseError, CapabilityMismatch
from .transport import OpenAIChatTransport

ROLES = ("planner", "researcher", "writer", "reviewer",
         "title_editor", "code_helper", "visual_reviewer")


@dataclass
class RouteConfig:
    primary: str
    fallbacks: list[str] = field(default_factory=list)
    thinking_policy: str = "provider_default"


@dataclass
class LLMRequest:
    role: str
    node: str
    prompt: str
    context: dict[str, Any] = field(default_factory=dict)
    schema: dict[str, Any] | None = None     # 简化 schema（本地校验）
    stream: bool = False
    system: str = ""
    timeout: float = 120.0
    images: list[str] = field(default_factory=list)  # Managed, bounded image Data URIs.
    history: list[dict[str, str]] = field(default_factory=list)


@dataclass
class LLMResponse:
    text: str
    data: dict[str, Any] | None = None       # 结构化输出
    profile_id: str = ""
    model_id: str = ""
    adapter: str = ""
    notes: list[str] = field(default_factory=list)
    fell_back: bool = False
    usage: dict[str, Any] = field(default_factory=dict)
    finish_reason: str = ""

    @property
    def json(self) -> dict[str, Any]:
        if self.data is None:
            raise SchemaInvalidError("该响应不是结构化输出")
        return self.data


class RoleRouter:
    def __init__(self, profiles: dict[str, ModelProfile],
                 routes: dict[str, RouteConfig], store: Store | None = None,
                 transport: OpenAIChatTransport | None = None,
                 invocation_hook: Callable[[dict[str, Any]], None] | None = None):
        self.profiles = profiles
        self.routes = routes
        self.store = store
        self.transport = transport or OpenAIChatTransport()
        self.invocation_hook = invocation_hook
        self.on_delta: Callable[[str, str], None] | None = None
        self.cancelled: Callable[[], bool] | None = None

    @property
    def snapshot(self) -> dict[str, Any]:
        return {"version": 2, "profiles": {pid: asdict(p) for pid, p in self.profiles.items()},
                "routes": {
            role: {"primary": r.primary, "fallbacks": list(r.fallbacks),
                   "thinking_policy": r.thinking_policy}
            for role, r in self.routes.items()}}

    def restore(self, snapshot: dict[str, Any]) -> None:
        if "profiles" in snapshot:
            self.profiles = {pid: ModelProfile(**p) for pid, p in snapshot["profiles"].items()}
            self.routes = {role: RouteConfig(**r) for role, r in snapshot["routes"].items()}
        elif snapshot:  # Explicit migration for v0.1 tasks; preserve their provider IDs.
            from .capabilities import PROVIDER_PRESETS, preset_profile
            routes = {role: RouteConfig(**r) for role, r in snapshot.items()}
            for route in routes.values():
                for pid in [route.primary, *route.fallbacks]:
                    if pid not in self.profiles:
                        aid = next((name for name in PROVIDER_PRESETS if pid.startswith(name)), None)
                        if aid is None:
                            raise ModelError("CONFIG_SNAPSHOT_INVALID", f"无法恢复模型配置 {pid}")
                        self.profiles[pid] = ModelProfile(**preset_profile(aid, profile_id=pid))
            self.routes = routes

    # ------------------------------------------------------------ 主入口
    def generate(self, req: LLMRequest, *, job_id: str | None = None,
                 max_attempts: int = 3) -> LLMResponse:
        route = self.routes.get(req.role)
        if route is None:
            raise ModelError("PARAM_UNSUPPORTED", f"角色未配置路由：{req.role}")
        chain = [route.primary, *route.fallbacks]
        last_error: ModelError | None = None
        for position, profile_id in enumerate(chain):
            profile = self.profiles.get(profile_id)
            if profile is None:
                continue
            adapter = make_adapter(profile, self.transport)
            try:
                if req.images and adapter.capabilities().get("vision") not in ("documented", "verified"):
                    raise CapabilityMismatch(f"{profile.model_id} 尚未确认支持图片输入，请先测试视觉模型")
                # 硬约束 preflight：能力不满足直接跳过该候选（§9.9）
                notes = adapter.preflight(route.thinking_policy)
            except ModelError as e:
                last_error = e
                self._record(job_id, req, profile, attempt=position + 1,
                             status=e.code, error=e)
                continue
            attempt = 0
            while attempt < max_attempts:
                attempt += 1
                try:
                    result = self._invoke(adapter, req, route, job_id=job_id, attempt=attempt)
                    result.notes.extend(notes)
                    result.fell_back = position > 0
                    if result.fell_back:
                        result.notes.append(
                            f"主模型不可用，已回退到 {profile.adapter}:{profile.model_id}"
                            "（本候选为完整重新生成，未与旧候选拼接）")
                    return result
                except ModelError as e:
                    last_error = e
                    if e.code in ("MODEL_BUDGET_EXCEEDED", "CONTENT_REFUSED", "CANCELLED"):
                        raise
                    if not e.retryable or attempt >= max_attempts:
                        break
                    time.sleep(min(0.2 * (2 ** (attempt - 1)), 2))
        if last_error is not None:
            raise last_error
        raise ModelError("PARAM_UNSUPPORTED", f"角色 {req.role} 没有可用模型配置")

    # -------------------------------------------------------------- 内部
    def _invoke(self, adapter, req: LLMRequest, route: RouteConfig, *, job_id=None, attempt=1) -> LLMResponse:
        messages: list[dict[str, Any]] = []
        if req.system:
            messages.append({"role": "system", "content": req.system})
        for message in req.history:
            if message.get('role') not in ('user', 'assistant') or not isinstance(message.get('content'), str):
                raise ValueError('对话历史格式无效')
            messages.append({'role': message['role'], 'content': message['content']})
        user_content = req.prompt
        if req.schema is not None:
            user_content += (
                "\n\n<context>" + json.dumps(
                    {**req.context, "node": req.node, "structured": True},
                    ensure_ascii=False) + "</context>\n"
                "请只输出符合以下 JSON 契约的 JSON 对象（不要输出其他文字）：\n"
                + json.dumps(req.schema, ensure_ascii=False))
        else:
            user_content += ("\n\n<context>" + json.dumps(
                {**req.context, "node": req.node}, ensure_ascii=False) + "</context>")
        messages.append({"role": "user", "content": image_message(user_content, req.images)})

        want_json = req.schema is not None
        chat = self._call(adapter, req, route, messages, job_id=job_id,
                          attempt=attempt, want_json=want_json, stream=req.stream)
        resp = LLMResponse(text=chat.content, profile_id=adapter.profile.profile_id,
                           model_id=chat.raw_model or adapter.profile.model_id,
                           adapter=adapter.adapter_id, notes=list(chat.notes),
                           usage=chat.usage or {"usage": "usage_unknown"},
                           finish_reason=chat.finish_reason)
        if want_json:
            try:
                if req.node == 'creative_chat' and req.context.get('mode') in ('draft', 'edit', 'images'):
                    from .creative_output import normalize_creative_output
                    try:
                        data, recovery_notes = normalize_creative_output(chat.content)
                        errors = validate_simple_schema(data, req.schema)
                    except SchemaInvalidError:
                        errors = ['无法直接恢复创作正文']
                    if not errors:
                        resp.data = data
                        resp.notes.extend(recovery_notes)
                    else:
                        resp.data = self._validate_structured(adapter, req, chat.content, route, job_id)
                else:
                    resp.data = self._validate_structured(adapter, req, chat.content, route, job_id)
            except ModelError as exc:
                # HTTP success is not an editorial success. Tie schema failure
                # to the exact invocation rather than the latest row from a
                # concurrently running conversation.
                invocation_id = getattr(chat, 'invocation_id', None)
                if self.store and invocation_id:
                    self.store.finish_invocation(invocation_id, exc.code, chat.usage or {'usage': 'usage_unknown'},
                                                 chat.finish_reason, str(exc)[:300])
                raise
        return resp

    def _call(self, adapter, req, route, messages, *, job_id=None, attempt=1,
              want_json=False, stream=False):
        if self.cancelled and self.cancelled():
            raise ModelError("CANCELLED", "任务已停止")
        inv = {"invocation_id": new_id("inv"), "job_id": job_id,
               "node_key": req.node, "role": req.role, "profile_id": adapter.profile.profile_id,
               "model_id": adapter.profile.model_id, "adapter": adapter.adapter_id,
               "attempt": attempt, "status": "sending", "request_hash": sha256_json(messages),
               "usage": {"usage": "usage_unknown"}}
        if self.store:
            job = self.store.get_job(job_id) if job_id else None
            maximum = int(job["limits"].get("max_model_calls", 20)) if job else None
            if job and job['workflow'] == 'supplement_images_v1':
                if req.node != 'image_prompts':
                    raise ModelError('IMAGE_ONLY_SCOPE', '补图任务只允许拟写配图提示词，原正文保持只读')
                maximum = int(job['limits'].get('max_image_model_calls', 12))
            self.store.reserve_invocation(inv, maximum)

        def delta(piece):
            if self.cancelled and self.cancelled():
                raise ModelError("CANCELLED", "任务已停止，远端费用可能仍产生")
            if self.on_delta:
                self.on_delta(req.node, piece)

        try:
            chat = adapter.chat(messages, thinking_policy=route.thinking_policy,
                                want_json=want_json, stream=stream, on_delta=delta,
                                timeout=req.timeout)
            chat.invocation_id = inv['invocation_id']
            if self.cancelled and self.cancelled():
                raise ModelError("CANCELLED", "任务已停止，未采纳本次候选")
            if chat.finish_reason not in ("stop",):
                raise IncompleteResponseError(f"模型正文未完成：{chat.finish_reason or 'missing'}")
            inv.update(status="ok", usage=chat.usage or {"usage": "usage_unknown"},
                       finish_reason=chat.finish_reason)
            return chat
        except Exception as exc:
            inv.update(status=getattr(exc, "code", "INTERNAL_ERROR"), error=str(exc)[:300])
            raise
        finally:
            if self.store:
                self.store.finish_invocation(inv["invocation_id"], inv["status"], inv["usage"],
                                             inv.get("finish_reason", ""), inv.get("error", ""))
            if self.invocation_hook:
                self.invocation_hook(inv)

    def _validate_structured(self, adapter, req: LLMRequest, text: str,
                             route: RouteConfig, job_id=None) -> dict[str, Any]:
        """解析 + 本地校验 + 一次受限修复（§9.13）。"""
        assert req.schema is not None
        errors = []
        try:
            obj = extract_json_block(text)
            errors = validate_simple_schema(obj, req.schema)
        except SchemaInvalidError as exc:
            obj = {}
            errors = [str(exc)]
        if errors:
            obj2 = self._repair_once(adapter, req, route, text, errors, job_id=job_id)
            errors2 = validate_simple_schema(obj2, req.schema)
            if errors2:
                raise SchemaInvalidError(
                    "结构化输出经一次修复仍不符合契约：" + "；".join(errors2[:5]))
            obj = obj2
        return obj

    def _repair_once(self, adapter, req: LLMRequest, route: RouteConfig,
                     original: str, errors: list[str] | None = None, *, job_id=None) -> dict:
        # Editorial documents must not lose their tail during format repair.
        # Most compatible models' complete Markdown is recovered locally first.
        original_for_repair = original if req.node == 'creative_chat' else original[:8000]
        if len(original_for_repair) > 180000:
            raise SchemaInvalidError('创作回复超过修复上限，请缩小写作范围后重试。')
        repair_prompt = (
            "下面的输出" + ("不是合法 JSON" if errors is None else
                          "不符合契约：" + "；".join(errors[:5])) +
            "。请只输出修正后的 JSON 对象，不要改其中的数字、代码与既定字段值。\n\n"
            + original_for_repair + "\n目标契约：" + json.dumps(req.schema, ensure_ascii=False))
        messages = ([{"role":"system","content":req.system}] if req.system else [])
        messages.append({"role":"user","content":image_message(repair_prompt,req.images)})
        chat = self._call(adapter, req, route,
                          messages,
                          job_id=job_id, want_json=True, attempt=2)
        if req.node == 'creative_chat' and req.context.get('mode') in ('draft', 'edit', 'images'):
            from .creative_output import normalize_creative_output
            return normalize_creative_output(chat.content)[0]
        return extract_json_block(chat.content)

    def _record(self, job_id, req, profile, *, attempt, status, usage=None,
                error: ModelError | None = None, model_id: str | None = None):
        if self.store is None and self.invocation_hook is None:
            return
        inv = {
            "invocation_id": new_id("inv"),
            "job_id": job_id,
            "node_key": req.node,
            "role": req.role,
            "profile_id": profile.profile_id,
            "model_id": model_id or profile.model_id,
            "adapter": profile.adapter,
            "attempt": attempt,
            "status": status,
            "request_hash": sha256_text(req.prompt)[:16],
            "usage": usage or {"usage": "unknown"},
            "finish_reason": "",
            "error": str(error)[:300] if error else "",
        }
        if self.store is not None:
            self.store.add_invocation(inv)
        if self.invocation_hook is not None:
            self.invocation_hook(inv)


def image_message(text: str, images: list[str]) -> str | list[dict[str, Any]]:
    """Keep normal text requests unchanged; only permit bounded local image data."""
    if not images:
        return text
    if not isinstance(images,list) or len(images)>4:
        raise ValueError("一次最多输入4张图片")
    parts = [{"type":"text","text":text}]
    for value in images:
        if not isinstance(value,str) or len(value)>3_000_000 or not value.startswith(("data:image/png;base64,","data:image/jpeg;base64,","data:image/webp;base64,")):
            raise ValueError("图片输入需为不超过3MB的本地图片Data URI")
        try:
            if not base64.b64decode(value.split(',',1)[1],validate=True):
                raise ValueError()
        except (ValueError,TypeError):
            raise ValueError("图片Base64编码无效") from None
        parts.append({"type":"image_url","image_url":{"url":value}})
    return parts


def result_usage(chat_result) -> dict[str, Any]:
    """用量缺失标记 usage_unknown，不记为零（§9.2）。"""
    if getattr(chat_result, "usage", None):
        return chat_result.usage
    return {"usage": "usage_unknown"}


# ------------------------------------------------------- 简化 schema 校验


def validate_simple_schema(obj: Any, schema: dict[str, Any]) -> list[str]:
    """本地业务契约校验（§9.13）：字段类型/枚举/必填/ID 引用。

    schema 形如：
      {"type": "object", "fields": {
          "name": {"type": "str", "required": True},
          "items": {"type": "list", "item": "str"},
          "mode": {"type": "enum", "values": ["a","b"]},
          "scores": {"type": "object", "fields": {...}}}}
    """
    errors: list[str] = []
    _validate(obj, schema, "$", errors)
    return errors


def _validate(obj: Any, spec: Any, path: str, errors: list[str]) -> None:
    if isinstance(spec, str):          # 简写："int" 等价 {"type": "int"}
        spec = {"type": spec}
    t = spec.get("type", "object")
    if t == "object":
        if not isinstance(obj, dict):
            errors.append(f"{path} 应为对象，实际 {type(obj).__name__}")
            return
        for name, sub in (spec.get("fields") or {}).items():
            if name not in obj:
                if isinstance(sub, str) or sub.get("required", True):
                    errors.append(f"{path}.{name} 缺失（必填）")
                continue
            _validate(obj[name], sub, f"{path}.{name}", errors)
    elif t == "list":
        if not isinstance(obj, list):
            errors.append(f"{path} 应为列表，实际 {type(obj).__name__}")
            return
        item_spec = spec.get("item")
        if len(obj) < spec.get("min_items", 0):
            errors.append(f"{path} 至少需要 {spec['min_items']} 项")
        for i, item in enumerate(obj):
            if item_spec:
                _validate(item, item_spec, f"{path}[{i}]", errors)
    elif t == "str":
        if not isinstance(obj, str):
            errors.append(f"{path} 应为字符串，实际 {type(obj).__name__}")
        elif spec.get("nonempty") and not obj.strip():
            errors.append(f"{path} 不能为空")
    elif t == "int":
        if not isinstance(obj, int) or isinstance(obj, bool):
            errors.append(f"{path} 应为整数，实际 {type(obj).__name__}")
    elif t == "num":
        if not isinstance(obj, (int, float)) or isinstance(obj, bool):
            errors.append(f"{path} 应为数字，实际 {type(obj).__name__}")
    elif t == "bool":
        if not isinstance(obj, bool):
            errors.append(f"{path} 应为布尔值")
    elif t == "enum":
        if obj not in spec.get("values", []):
            errors.append(f"{path} 取值 {obj!r} 不在允许集合内")
    elif t == "any":
        return
    if t in ("int", "num") and isinstance(obj, (int, float)) and not isinstance(obj, bool):
        if "minimum" in spec and obj < spec["minimum"]:
            errors.append(f"{path} 小于允许最小值")
        if "maximum" in spec and obj > spec["maximum"]:
            errors.append(f"{path} 大于允许最大值")
