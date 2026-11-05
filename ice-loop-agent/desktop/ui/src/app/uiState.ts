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
