// 由 scripts/gen-ts-types.mjs 从 ../../contracts/*.schema.json 生成，勿手改。
// 权威来源：ice_agent/contracts（Pydantic）。漂移由 tests/test_v2_contracts.py 阻断。

export type IChatReceiptResponse = {
  "message_id": string;
  "user_message_id": string;
  "started": boolean;
  "accepted": true;
  "replayed": boolean;
  "status": "streaming" | "completed" | "failed" | "stopped" | "interrupted";
} | {
  "accepted": false;
  "cancelled": true;
  "request_id": string;
} | {
  "accepted": false;
  "found": false;
};

export type IChatSendRequest = {
  "conversation_id": string;
  "text"?: string;
  "mode"?: "discuss" | "draft" | "edit" | "images";
  "references"?: Array<string>;
  "citations"?: Array<{
    "chunk_id": string;
    "hash"?: string | null;
  }>;
  "documents"?: Array<{
    "source_name": string;
    "text": string;
  }>;
  "selected_text"?: string;
  "profile_id"?: string | null;
  "clarification_message_id"?: string | null;
  "clarification_answers"?: Record<string, string>;
  "retry_message_id"?: string | null;
  "candidate_id"?: string | null;
  /** 同一账号/会话内相同请求返回原消息；内容改变须使用新的请求标识 */
  "request_id"?: string | null;
};

export type IChatSendResponse = {
  "message_id": string;
  "user_message_id": string;
  "started": boolean;
  "accepted": true;
  "replayed": boolean;
  "status": "streaming" | "completed" | "failed" | "stopped" | "interrupted";
} | {
  "accepted": false;
  "cancelled": true;
  "request_id": string;
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
  "id"?: string | number | null;
  "method": string;
  "params"?: Record<string, unknown>;
};

export type IRpcResponse = {
  "kind"?: "response";
  "id"?: string | number | null;
  "result"?: unknown;
  "error"?: {
    "code": "VALIDATION_ERROR" | "NOT_FOUND" | "ACCOUNT_MISMATCH" | "REVISION_CONFLICT" | "BUDGET_EXCEEDED" | "PERMISSION_DENIED" | "CANCELLED" | "NETWORK" | "PROVIDER_ERROR" | "CAPABILITY_MISMATCH" | "IDEMPOTENCY_CONFLICT" | "STATE_CONFLICT" | "INTERNAL";
    "message": string;
    "recoverable"?: boolean;
    "action"?: "retry" | "adjust_input" | "resolve_conflict" | "check_budget" | "contact_support" | null;
    "request_id"?: string | null;
  } | null;
};
