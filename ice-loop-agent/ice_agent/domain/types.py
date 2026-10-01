"""核心领域类型（设计文档 §8、§9.4、§10.2、§13.1、§14.4、§17.2）。

所有跨节点传递的数据都定义为可 JSON 序列化的 dataclass，
SQLite 中保存其序列化形态，文件产物保存 sha256 引用。
"""
from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------- 基础工具


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_json(obj: Any) -> str:
    return sha256_text(json.dumps(obj, ensure_ascii=False, sort_keys=True))


def to_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False)


# ------------------------------------------------------- 任务与文章状态

JOB_STATES = (
    "queued", "running", "awaiting_approval", "awaiting_user",
    "paused", "failed", "cancelled", "completed",
)
# 文章就绪状态与任务状态分离（§8.2）
READINESS = (
    "draft", "text_verified", "assets_pending", "review_pending",
    "ready_for_publish", "published",
)

WORKFLOW_NODES = (
    "ingest", "topic", "research", "outline", "draft", "verify_code",
    "integrate_evidence", "article_review", "style_review", "title_workshop",
    "asset_plan", "assets", "final_check", "export",
)

APPROVAL_SCOPES = ("topic", "outline", "final_title", "asset_plan")


@dataclass
class ArticleSpec:
    """一篇文章任务的输入规格（POST /v1/jobs 的 request 部分）。"""

    series: str                      # PY / JV / AI / WK
    episode: int
    topic: str
    previous_article_id: str | None = None
    exercise_to_answer: str | None = None   # 上一篇动手题原文
    next_episode_plan: str | None = None    # 下期预告文案
    target_words: tuple[int, int] = (1800, 2600)
    audience: str = "零基础在校学生"
    core_benefit: str = ""
    materials: list[dict[str, Any]] = field(default_factory=list)  # 用户素材/来源
    execution_mode: str = "local_reviewed"  # isolated_container 预留
    image_provider: str = "manual_import"   # tapnow_browser / tapnow_mcp / manual_import
    job_mode: str = "semi_auto"             # assisted / semi_auto / preapproved

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["target_words"] = list(self.target_words)
        return d


@dataclass
class Approval:
    """一个人工审核门记录；批准与内容 hash 绑定（§17.2 approvals）。"""

    approval_id: str
    job_id: str
    scope: str                 # topic / outline / final_title / asset_plan
    revision: int
    content_hash: str
    payload: dict[str, Any]
    status: str = "pending"    # pending / approved / rejected
    decision_note: str = ""
    decided_by: str = ""
    decided_at: str | None = None
    created_at: str = field(default_factory=now_iso)


@dataclass
class ModelProfile:
    """模型配置：服务平台 + 端点 + model_id 分离（§9.5）。"""

    profile_id: str
    adapter: str               # qwen / deepseek / kimi / bigmodel / ark / mock
    service: str               # bailian / deepseek-native / moonshot-cn / ...
    protocol: str = "chat_completions"
    base_url: str = ""
    model_id: str = ""
    api_key_env: str = ""      # 只存环境变量名
    region: str = ""
    status: str = "requires_probe"   # requires_probe / verified / disabled
    capabilities: dict[str, str] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    def credential(self) -> str | None:
        from ..config import resolve_credential

        return resolve_credential(self.api_key_env) if self.api_key_env else None


# ------------------------------------------------------- 证据与运行记录

RISK_TYPES = ("stable", "version", "price", "quota", "model", "policy", "performance")
CLAIM_STATUS = ("verified", "qualified", "needs_check", "conflict", "removed")


@dataclass
class Source:
    source_id: str
    url: str
    title: str
    tier: int = 3              # 1 官方 / 2a 官方身份个人 / 2b 3 4 线索
    retrieved_at: str = field(default_factory=now_iso)
    content_hash: str = ""
    summary: str = ""


@dataclass
class Claim:
    """高风险断言（§10.2）：正文断言必须有来源与核验状态。"""

    claim_id: str
    text: str
    risk_type: str = "stable"
    source_ids: list[str] = field(default_factory=list)
    status: str = "needs_check"
    verified_at: str | None = None
    publish_day_check_required: bool = False
    review_notes: str = ""


@dataclass
class RunSpec:
    """一次代码执行的计划（§14.1）：argv 列表，禁止模型拼 shell 字符串。"""

    language: str              # python / java
    source: str
    filename: str
    stdin_events: list[str] = field(default_factory=list)
    timeout_s: float = 30.0
    expected: str = ""         # 教学预期输出（用于比较，不作断言）
    expect_failure: bool = False   # 预期报错素材（§14.5）


@dataclass
class RunRecord:
    """真实执行记录（§14.4）：输出文件 + hash 可追溯。"""

    run_id: str
    code_artifact_id: str
    code_sha256: str
    execution_mode: str
    argv: list[str]
    runtime: dict[str, str]
    stdin_events: list[str]
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool
    started_at: str
    duration_ms: int
    output_sha256: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------- 资产

@dataclass
class AssetSlot:
    """图位（§16.1）：图号与 P 编号分别唯一。"""

    slot_id: str
    figure_no: int
    prompt_no: int | None      # 生图才有 P 编号
    kind: str                  # cover / body_real / body_diagram / atmosphere
    position: str              # 正文位置描述
    caption: str
    required: bool = True
    obtain: str = "manual"     # manual / generate / run_view / cover_template
    placeholder: str = ""
    prompt: str = ""           # 英文一段式七要素
    reference_image: str = ""
    selected_candidate: str | None = None


@dataclass
class AssetCandidate:
    candidate_id: str
    slot_id: str
    source: str = "manual_import"
    file_path: str = ""
    sha256: str = ""
    review_status: str = "pending"   # pending / accepted / rejected
    created_at: str = field(default_factory=now_iso)


# ----------------------------------------------------------- 操作账本

OPERATION_STATUS = (
    "prepared", "sending", "submitted", "running", "succeeded",
    "failed_confirmed", "not_submitted_confirmed", "unknown", "needs_reconciliation",
)


@dataclass
class Operation:
    """外部副作用操作（§13.1）：生图等提交的幂等账本行。"""

    operation_id: str
    operation_key: str
    article_id: str
    slot_id: str
    candidate_index: int
    provider: str
    prompt_hash: str
    settings_hash: str
    status: str = "prepared"
    provider_task_ref: str = ""
    provider_asset_refs: list[str] = field(default_factory=list)
    reserved_budget: int = 1
    observed_cost: str = "unknown"
    error_code: str = ""
    created_at: str = field(default_factory=now_iso)
    last_checked_at: str = field(default_factory=now_iso)
    notes: str = ""


# --------------------------------------------------------- 修订与版本

@dataclass
class Revision:
    """文稿版本：不覆盖旧版本（§17.2 article_revisions）。"""

    revision_id: str
    article_id: str
    kind: str                  # outline / draft / final / title_report / ...
    content: str
    content_hash: str
    parent_revision: str | None = None
    created_at: str = field(default_factory=now_iso)
    producer: str = ""         # 产生节点或 "user"
