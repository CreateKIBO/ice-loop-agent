// preload 暴露的桌面能力（非 RPC 部分）。都是可选的：在浏览器里预览界面时不存在。
import { flushAllDirty } from "./client";
import type { BackupSummary,RestoredBackup } from '../features/backup/backupModel';

declare global {
  interface Window {
    ice?: {
      pickKnowledgeFile?: () => Promise<string | null>;
      importOutline?: (accountId:string) => Promise<{text:string;source_name:string;file_hash:string}|null>;
      createBackup?: () => Promise<BackupSummary|null>;
      inspectBackup?: () => Promise<BackupSummary|null>;
      restoreBackup?: (token:string) => Promise<RestoredBackup|null>;
      activateRestoredBackup?: (token:string) => Promise<RestoredBackup>;
      choosePublicationDir?: (kind:'library'|'output') => Promise<string|null>;
      exportPublication?: () => Promise<{file:string}|null>;
      chooseExportDir?: () => Promise<string|null>;
      cancelExportDir?: (destination:string) => Promise<{ok:boolean}>;
      openExportFolder?: (destination:string) => Promise<{ok:boolean}>;
      saveKey?: (provider: string, key: string) => Promise<{ ok: boolean }>;
      switchUi?: (mode: "new" | "classic") => Promise<{ ok: boolean }>;
      relaunch?: () => Promise<{ ok: boolean }>;
      onEngineExit?: (callback: () => void) => () => void;
    } & Record<string, unknown>;
  }
}

/** 切到经典界面并记住选择；先落盘编辑中的草稿，落盘失败则不切换。 */
export async function switchToClassic(): Promise<void> {
  await flushAllDirty();
  if (window.ice?.switchUi) await window.ice.switchUi("classic");
  else window.location.assign("ice://app/index.html");
}

export async function relaunchApp(): Promise<void> {
  if (window.ice?.relaunch) await window.ice.relaunch();
  else window.location.reload();
}

export function onEngineExit(callback: () => void): () => void {
  return window.ice?.onEngineExit?.(callback) ?? (() => {});
}
