// 多处入口共用的业务动作（左栏、命令面板、欢迎页、快捷键）。
import { accountStore, conversationStore, editorStore, flushAllDirty, queryClient, resetForAccountSwitch, rpc } from "./client";
import { refreshAfterWrite } from "./receipts";
import type { ChatResult } from "./workbenchResponses";
import { stageComposerDraft, type ComposerDraft } from './composerDraft';

/** Install an acknowledged account snapshot without reloading the whole app. */
export function applyAccountBootstrap<T extends {account:{id:string}}>(result:T) {
  const id=result.account.id;
  if(id!==accountStore.get())resetForAccountSwitch(id);
  queryClient.setQueryData(['ice',id,'bootstrap',{}],result);
  void queryClient.invalidateQueries({queryKey:['ice',id],refetchType:'active'});
}

/**
 * 新建会话并切过去。requestId 用于幂等：同一次点击失败后重试不会建出两个会话，
 * 调用方在成功后丢弃它。
 */
export async function createConversation(requestId: string = crypto.randomUUID(),
  options: {series?:string;title?:string;initialInput?:ComposerDraft;editorialPlan?:{plan_id:string;confirmation_hash:string}} = {}): Promise<string> {
  await flushAllDirty();
  const account = accountStore.get();
  const result = await rpc<ChatResult>("chat.create", { account_id: account, request_id: requestId,
    ...(options.series?{series:options.series}:{}),...(options.title?{title:options.title}:{}),
    ...(options.editorialPlan?{editorial_plan:options.editorialPlan}:{}) });
  // 会话已创建成功；列表刷新失败只提示刷新，不把成功冒充成"新建失败"
  // 诱导用新请求键重试（那会建出第二个会话）（批次A-04）。
  await refreshAfterWrite("会话创建", () => queryClient.invalidateQueries(
    { queryKey: ["ice", account, "chat.list"] }, { throwOnError: true }));
  if(accountStore.get()!==account)throw Error('公众号已切换，会话已保存在原公众号，请切回查看；当前输入保留');
  if(options.initialInput)stageComposerDraft(account,result.conversation.id,options.initialInput);
  editorStore.set(null);
  conversationStore.set(result.conversation.id);
  return result.conversation.id;
}

export async function openGettingStarted(): Promise<void> {
  await flushAllDirty(); editorStore.set(null); conversationStore.set(null);
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
