// 多处入口共用的业务动作（左栏、命令面板、欢迎页、快捷键）。
import { accountStore, conversationStore, editorStore, flushAllDirty, queryClient, rpc } from "./client";
import type { ChatResult } from "./workbenchResponses";

/**
 * 新建会话并切过去。requestId 用于幂等：同一次点击失败后重试不会建出两个会话，
 * 调用方在成功后丢弃它。
 */
export async function createConversation(requestId: string = crypto.randomUUID()): Promise<string> {
  await flushAllDirty();
  const account = accountStore.get();
  const result = await rpc<ChatResult>("chat.create", { account_id: account, request_id: requestId });
  await queryClient.invalidateQueries({ queryKey: ["ice", account, "chat.list"] });
  editorStore.set(null);
  conversationStore.set(result.conversation.id);
  return result.conversation.id;
}

export async function openConversation(id: string): Promise<void> {
  await flushAllDirty();
  editorStore.set(null);
  conversationStore.set(id);
}

export async function openEditor(jobId: string): Promise<void> {
  await flushAllDirty();
  editorStore.set(jobId);
}
