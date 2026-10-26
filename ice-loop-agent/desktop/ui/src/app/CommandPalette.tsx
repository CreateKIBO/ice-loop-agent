// Ctrl+K 命令面板（M2-09）：打开/关闭返回焦点；动作覆盖编辑器与导航。
// 会话与任务列表复用左栏/右栏同一 query key，打开面板不额外请求。
import * as React from "react";

import { Dialog, Input } from "../components/ui";
import { toast } from "../components/toast";
import { createConversation, openConversation, openEditor,openGettingStarted } from "../data/actions";
import { editorStore, flushAllDirty, useAccountQuery, useEditorJob } from "../data/client";
import { switchToClassic } from "../data/desktop";
import { editorialStore,backupSettingsStore, paletteStore, publicationSettingsStore, settingsStore, shortcutHelpStore } from "./uiState";

type Action = {
  id: string; label: string; group: string; hint?: string; keywords?: string;
  run: () => void | Promise<void>;
};
type ConversationRow = { id: string; title: string; archived: number | boolean; deleted: number | boolean };
type JobRow = { job_id: string; state: string; topic: string; final_title: string | null; series: string; episode: number };

const PER_GROUP = 8;

export function CommandPalette({ open, onOpenChange }: {
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false);
  const restoreFocus = React.useRef<HTMLElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);
  const editorJob = useEditorJob();

  const conversations = useAccountQuery<ConversationRow[]>("chat.list",
    { archived: false, deleted: false }, { enabled: open, staleTime: 3_000 });
  const jobs = useAccountQuery<JobRow[]>("jobs.list", { visibility: "active" }, { enabled: open, staleTime: 3_000 });

  React.useEffect(() => {
    let timer: number | undefined;
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setActiveIndex(0);
      setQuery("");
      setActionError(null);
      timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    } else if (restoreFocus.current) {
      restoreFocus.current.focus();
      restoreFocus.current = null;
    }
    return () => window.clearTimeout(timer);
  }, [open]);

  const actions = React.useMemo<Action[]>(() => {
    const list: Action[] = [{
      id: "new-conversation", group: "操作", label: "新建会话", hint: "Ctrl N", keywords: "new chat 讨论",
      run: async () => { await createConversation(); },
    }];
    if (editorJob) {
      list.push({
        id: "close-editor", group: "操作", label: "返回对话", hint: "未保存的修改会先存为工作草稿",
        run: async () => { await flushAllDirty(); editorStore.set(null); },
      });
    }
    list.push({
      id:'getting-started',group:'操作',label:'开始指南',keywords:'首次使用 导入 配置 first start home',run:openGettingStarted,
    },{
      id:'shortcut-help',group:'操作',label:'快捷键与操作帮助',keywords:'快捷键 键盘 帮助 keyboard shortcuts help',
      run:()=>shortcutHelpStore.set(true),
    },{
      id:'publication-settings',group:'操作',label:'公众号与品牌',keywords:'账号 新增 公众号 品牌 历史 导入 account brand',
      run:()=>publicationSettingsStore.set(true),
    },{
      id: "model-settings", group: "操作", label: "模型与 Key 设置", hint: "Ctrl ,", keywords: "model key api 供应商 设置",
      run: () => { settingsStore.set(true); },
    }, {
      id:'backup-settings',group:'操作',label:'备份与恢复',keywords:'backup restore 迁移 导出 工作台 数据',run:()=>backupSettingsStore.set(true),
    },{
      id:'editorial',group:'操作',label:'选题与排期',keywords:'标题 大纲 历史 期号 已发布 计划 outline roadmap',run:()=>editorialStore.set(true),
    }, {
      id: "classic-ui", group: "操作", label: "切换到经典界面", hint: "更多管理工具",
      keywords: "classic 旧版 经典 素材 备份 版本",
      run: () => switchToClassic(),
    });
    // 编辑器只对已完成的任务开放（与任务卡「编辑正文」一致）。
    for (const job of (jobs.data ?? []).filter(row => row.state === "completed")) {
      const title = job.final_title || job.topic;
      list.push({
        id: "edit:" + job.job_id, group: "编辑文章", label: title,
        hint: `${job.series}-${String(job.episode).padStart(3, "0")}`,
        keywords: job.series + job.episode, run: () => openEditor(job.job_id),
      });
    }
    for (const row of conversations.data ?? []) {
      if (row.archived || row.deleted) continue;
      list.push({ id: "chat:" + row.id, group: "打开会话", label: row.title, run: () => openConversation(row.id) });
    }
    return list;
  }, [editorJob, jobs.data, conversations.data]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const counts = new Map<string, number>();
    return actions.filter(action => {
      const haystack = (action.label + " " + (action.hint ?? "") + " " + (action.keywords ?? "")).toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
      const count = counts.get(action.group) ?? 0;
      if (count >= PER_GROUP) return false;
      counts.set(action.group, count + 1);
      return true;
    });
  }, [actions, query]);

  const clampedIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));
  const active = filtered[clampedIndex];

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${clampedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, filtered.length]);

  const execute = async (action: Action) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setActionError(null);
    setRunning(true);
    // 标明被阻止的动作（C4）：仅 flush/写入失败时用户才知道哪条命令没有执行；原始错误全文保留。
    try { await action.run(); onOpenChange(false); }
    catch (error) { setActionError(`「${action.label}」未执行：${(error as Error).message}`); }
    finally { runningRef.current = false; setRunning(false); }
  };

  const loading = open && (conversations.isLoading || jobs.isLoading);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="命令面板（Ctrl+K）"
            footer={<span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
              ↑↓ 选择 · Enter 执行 · Esc 关闭</span>}>
      <div style={{ display: "grid", gap: 8 }}>
        <Input ref={inputRef} value={query} placeholder="搜索命令、会话或文章标题…" aria-label="搜索命令"
               role="combobox" aria-expanded aria-controls="ice-palette-list"
               aria-activedescendant={active ? "ice-palette-" + clampedIndex : undefined}
               onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
               onKeyDown={event => {
                 if (event.nativeEvent.isComposing) return;
                 if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(Math.min(clampedIndex + 1, filtered.length - 1)); }
                 if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(Math.max(clampedIndex - 1, 0)); }
                 if (event.key === "Enter" && active) {
                   event.preventDefault();
                   void execute(active);
                 }
               }} />
        <ul ref={listRef} id="ice-palette-list" role="listbox" aria-label="可用命令"
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2,
                     gridTemplateColumns: "minmax(0, 1fr)", maxHeight: "min(420px, 55vh)", overflowY: "auto" }}>
          {filtered.map((action, index) => (
            <React.Fragment key={action.id}>
              {(index === 0 || filtered[index - 1].group !== action.group) && (
                <li role="presentation" style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)",
                                                 padding: "6px 10px 2px", fontWeight: 600 }}>{action.group}</li>
              )}
              <li id={"ice-palette-" + index} data-index={index} role="option" aria-selected={index === clampedIndex}
                  onMouseMove={() => { if (index !== clampedIndex) setActiveIndex(index); }}
                  onClick={() => { void execute(action); }}
                  style={{
                    display: "flex", alignItems: "baseline", gap: 8, padding: "6px 10px",
                    cursor: running ? "progress" : "pointer", borderRadius: 6,
                    background: index === clampedIndex ? "var(--ice-info-bg)" : "transparent",
                  }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {action.label}
                </span>
                {action.hint && <span style={{ color: "var(--ice-text-secondary)", fontSize: 12, flexShrink: 0 }}>{action.hint}</span>}
              </li>
            </React.Fragment>
          ))}
          {filtered.length === 0 && !loading && (
            <li role="presentation" style={{ color: "var(--ice-text-secondary)", padding: 8 }}>没有匹配的命令、会话或文章</li>
          )}
          {loading && (
            <li role="presentation" style={{ color: "var(--ice-text-secondary)", padding: 8 }}>正在读取会话和任务…</li>
          )}
        </ul>
        {actionError && <div role="alert" className="ice-error-text">{actionError}</div>}
      </div>
    </Dialog>
  );
}

/**
 * 全局快捷键：Ctrl+K 命令面板、Ctrl+N 新建会话、Ctrl+, 模型设置。
 * 编辑器内的 Ctrl+S 由 ArticleEditor 自己处理。
 */
export function useGlobalShortcuts() {
  React.useEffect(() => {
    let creating = false;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        paletteStore.set(!paletteStore.get());
      } else if (key === ",") {
        event.preventDefault();
        settingsStore.set(true);
      } else if (key === "n") {
        event.preventDefault();
        if (creating) return;
        creating = true;
        createConversation()
          .catch(error => toast.error({ title: "新建会话失败", detail: (error as Error).message }))
          .finally(() => { creating = false; });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
