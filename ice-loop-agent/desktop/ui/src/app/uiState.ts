// 界面级开关（命令面板、模型设置、引擎状态）：任何位置都能打开，不必层层传回调。
import { useSyncExternalStore } from "react";

function createValueStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const store = {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach(listener => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return { ...store, use: () => useSyncExternalStore(store.subscribe, store.get) };
}

export const paletteStore = createValueStore(false);
export const settingsStore = createValueStore(false);
export const skillSettingsStore = createValueStore(false);
export const shortcutHelpStore = createValueStore(false);
export const backupSettingsStore = createValueStore(false);
export const editorialStore = createValueStore(false);
export const publicationSettingsStore = createValueStore(false);
export const publicationEntryStore = createValueStore<"identity" | "new" | "history">("identity");
export function openPublicationSetup(entry: "identity" | "new" | "history") {
  publicationEntryStore.set(entry); publicationSettingsStore.set(true);
}
/** 第29轮：刚保存的草稿 id，供左栏草稿箱定位并轻闪一次；at 用于丢弃过期请求（左栏收起时不补闪）。 */
export const draftFlashStore = createValueStore<{ id: string; at: number } | null>(null);
export function flashDraft(id: string) { draftFlashStore.set({ id, at: Date.now() }); }
export const engineStore = createValueStore<"ready" | "exited">("ready");

/** v3（C-01）：主区三入口。默认进入“文章”；“网页”以浮层打开，不占用此状态。 */
export type Workspace = "articles" | "assistant";
function initialWorkspace(): Workspace {
  try { return window.localStorage.getItem("ice.ui.workspace") === "assistant" ? "assistant" : "articles"; }
  catch { return "articles"; }
}
export const workspaceStore = createValueStore<Workspace>(initialWorkspace());
export function setWorkspace(next: Workspace) {
  workspaceStore.set(next);
  try { window.localStorage.setItem("ice.ui.workspace", next); } catch { /* 记忆失败不影响导航 */ }
}
/** 当前打开的普通文章（document_id）；与旧 jobId 编辑器互不复用。 */
export const documentStore = createValueStore<string | null>(null);
/** 粘贴导入/AI 起草对话框（文章首页与命令面板共用）。 */
export const articleCreateStore = createValueStore<null | "paste" | "ai">(null);
