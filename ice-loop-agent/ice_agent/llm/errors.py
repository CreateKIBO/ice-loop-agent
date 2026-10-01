"""模型错误分类（设计文档 §9.14 / §13.4）。

错误码稳定，供路由层决定：重试 / 换备用 / 停止并提示用户。
"""
from __future__ import annotations


class ModelError(Exception):
    """模型调用错误基类；code 为稳定错误码。"""

    retryable = False

    def __init__(self, code: str, message: str, *, status: int | None = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.status = status


class AuthError(ModelError):
    """401/403：Key、地域或模型权限问题；禁用该 profile，不反复重试。"""

    retryable = False

    def __init__(self, message: str, status: int | None = None):
        super().__init__("AUTH_FAILED", message, status=status)


class RateLimitError(ModelError):
    """429：可按退避重试或换已配置备用。"""

    retryable = True

    def __init__(self, message: str, status: int | None = None):
        super().__init__("RATE_LIMIT", message, status=status)


class ServerError(ModelError):
    """5xx：暂时性服务端错误，可退避。"""

    retryable = True

    def __init__(self, message: str, status: int | None = None):
        super().__init__("SERVER_ERROR", message, status=status)


class NetworkError(ModelError):
    """连接失败 / 流中断：旧候选保持 incomplete，重新生成完整候选。"""

    retryable = True

    def __init__(self, message: str):
        super().__init__("NETWORK", message)


class ContextLengthError(ModelError):
    """上下文或输出超限：压缩或分章节，不盲目换大模型。"""

    retryable = False

    def __init__(self, message: str):
        super().__init__("CONTEXT_LENGTH", message)


class ParamUnsupportedError(ModelError):
    """参数不被模型支持：preflight 拒绝或修正能力标签。"""

    retryable = False

    def __init__(self, message: str):
        super().__init__("PARAM_UNSUPPORTED", message)


class ContentRefusedError(ModelError):
    """内容拒绝：返回可解释失败，不通过跨平台回退绕过。"""

    retryable = False

    def __init__(self, message: str):
        super().__init__("CONTENT_REFUSED", message)


class CapabilityMismatch(ModelError):
    """MODEL_CAPABILITY_MISMATCH：required_off/required_on 无合格模型。"""

    retryable = False

    def __init__(self, message: str):
        super().__init__("MODEL_CAPABILITY_MISMATCH", message)


class EmptyResponseError(ModelError):
    """零正文 / JSON 空内容不能算成功。"""

    retryable = True

    def __init__(self, message: str):
        super().__init__("EMPTY_RESPONSE", message)


class SchemaInvalidError(ModelError):
    """结构化输出经一次受限修复仍不符合本地契约。"""

    retryable = False

    def __init__(self, message: str):
        super().__init__("SCHEMA_INVALID", message)


class IncompleteResponseError(ModelError):
    retryable = False

    def __init__(self, message: str):
        super().__init__("RESPONSE_INCOMPLETE", message)


class ModelBudgetExceeded(ModelError):
    def __init__(self, message: str):
        super().__init__("MODEL_BUDGET_EXCEEDED", message)
