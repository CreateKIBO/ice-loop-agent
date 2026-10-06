// 由 scripts/gen-ts-types.mjs 从 ../../contracts/*.schema.json 生成，勿手改。
// 权威来源：ice_agent/contracts（Pydantic）。漂移由 tests/test_v2_contracts.py 阻断。

export type IChatSendRequest = {
  "conversation_id": string;
  "text"?: string;
  "mode"?: "discuss" | "draft" | "edit" | "images";
  "references"?: Array<string>;
  "clarification_message_id"?: string | null;
  "candidate_id"?: string | null;
  /** 幂等键：同一会话重复提交同 request_id 返回同一结果 */
  "request_id"?: string | null;
};

export type IModelDeltaPayload = {
  "turn_id": string;
  "attempt_id": string;
  "text": string;
};

export type IProtocolEvent = {
  "kind"?: "event";
  "protocol_version"?: 2;
  "event_id": string;
  "stream_id": string;
  "account_id": string;
  "sequence": number;
  "type": string;
  "payload"?: Record<string, unknown>;
};

export type IRpcError = {
  "code": "VALIDATION_ERROR" | "NOT_FOUND" | "ACCOUNT_MISMATCH" | "REVISION_CONFLICT" | "BUDGET_EXCEEDED" | "PERMISSION_DENIED" | "CANCELLED" | "NETWORK" | "PROVIDER_ERROR" | "CAPABILITY_MISMATCH" | "IDEMPOTENCY_CONFLICT" | "STATE_CONFLICT" | "INTERNAL";
  "message": string;
  "recoverable"?: boolean;
  "action"?: "retry" | "adjust_input" | "resolve_conflict" | "check_budget" | "contact_support" | null;
  "request_id"?: string | null;
};

export type IRpcRequest = {
  /** 请求关联 ID；通知类可为空 */
  "id"?: string | null;
  "method": string;
  "params"?: Record<string, unknown>;
};

export type IRpcResponse = {
  "kind"?: "response";
  "id"?: string | null;
  "result"?: unknown /* unsupported: {"default":null,"title":"Result"} */;
  "error"?: {
    "code": "VALIDATION_ERROR" | "NOT_FOUND" | "ACCOUNT_MISMATCH" | "REVISION_CONFLICT" | "BUDGET_EXCEEDED" | "PERMISSION_DENIED" | "CANCELLED" | "NETWORK" | "PROVIDER_ERROR" | "CAPABILITY_MISMATCH" | "IDEMPOTENCY_CONFLICT" | "STATE_CONFLICT" | "INTERNAL";
    "message": string;
    "recoverable"?: boolean;
    "action"?: "retry" | "adjust_input" | "resolve_conflict" | "check_budget" | "contact_support" | null;
    "request_id"?: string | null;
  } | null;
};
