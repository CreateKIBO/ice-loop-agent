// 左栏导航（M2-04 + R04/R12 批次二）：账号切换（先落盘脏对象）、新建会话、
// 最近会话（归档/删除/恢复）、草稿箱（真实 chat.drafts 列表 + 正文查看）。
import * as React from "react";
import { useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, Dialog, EmptyState, Input, SkeletonRows, Spinner } from "../../components/ui";
import { toast } from "../../components/toast";
import { createConversation } from "../../data/actions";
import {
  accountStore, conversationStore, editorStore, flushAllDirty, queryClient, resetForAccountSwitch,
  rpc, useAccountQuery, type RpcError,
} from "../../data/client";
import { switchToClassic } from "../../data/desktop";
import { useModelReadiness } from "../../app/ModelSettings";
import { settingsStore } from "../../app/uiState";

type BootstrapAccount = { id: string; name: string };
type ConversationRow = {
  id: string; title: string; updated_at: string;
  archived: number | boolean; deleted: number | boolean;
};
type DraftRow = {
  draft_id: string; title: string; status: string; updated_at?: string;
  body?: string; series?: string; episode?: number | null;
};

type ListView = "active" | "archived" | "deleted";
const VIEWS: Array<{ value: ListView; label: string }> = [
  { value: "active", label: "最近" }, { value: "archived", label: "归档" }, { value: "deleted", label: "回收站" },
];

/** 今天显示时刻，今年显示月日，更早显示年月日；解析失败返回空串而不是 "Invalid Date"。 */
export function shortTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

// 归档/删除/恢复会影响多个视图（最近、归档、回收站各是一个查询），统一按前缀失效。
const refreshConversationLists = () =>
  queryClient.invalidateQueries({ queryKey: ["ice", accountStore.get(), "chat.list"] });

export function LeftNav({ accounts, activeAccountId, version }: {
  accounts: BootstrapAccount[]; activeAccountId: string; version?: string;
}) {
  const [filter, setFilter] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<ListView>("active");
  const showArchived = view === "archived", showDeleted = view === "deleted";
  const requestId = React.useRef<string | null>(null);
  const conversations = useAccountQuery<ConversationRow[]>("chat.list", { archived: showArchived, deleted: showDeleted },
    { staleTime: 3_000, refetchInterval: 15_000 });
  const drafts = useAccountQuery<DraftRow[]>("chat.drafts", {},
    { staleTime: 5_000, refetchInterval: 20_000 });

  const filtered = React.useMemo(() => {
    const rows = conversations.data ?? [];
    const needle = filter.trim().toLowerCase();
    const visible = rows.filter(row => showDeleted ? row.deleted : showArchived
      ? (!row.deleted && !!row.archived)
      : (!row.deleted && !row.archived));
    if (!needle) return visible;
    return visible.filter(row => row.title.toLowerCase().includes(needle));
  }, [conversations.data, filter, showArchived, showDeleted]);

  const newConversation = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      await createConversation(requestId.current); // 内含导航前落盘（R04）
      requestId.current = null;
      setView("active");
      setFilter("");
    } catch (error) { setCreateError((error as Error).message); }
    finally { setCreating(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <AccountSwitcher accounts={accounts} activeAccountId={activeAccountId} />
      <div style={{ padding: "0 var(--ice-space-3) var(--ice-space-2)" }}>
        <Button variant="primary" loading={creating} disabled={creating} onClick={newConversation}>新建会话</Button>
        {createError && <div role="alert" style={{ color: "var(--ice-danger)", marginTop: 8 }}>{createError}</div>}
      </div>
      <div style={{ padding: "0 var(--ice-space-3) var(--ice-space-2)", display: "grid", gap: "var(--ice-space-2)" }}>
        <Input placeholder="搜索会话（当前公众号）" value={filter} type="search"
               onChange={event => setFilter(event.target.value)}
               onKeyDown={event => { if (event.key === "Escape" && filter) { event.preventDefault(); setFilter(""); } }}
               aria-label="搜索会话" style={{ width: "100%" }} />
        <div className="ice-segmented ice-segmented--animated" role="group" aria-label="会话筛选">
          {VIEWS.map(option => (
            <button key={option.value} type="button" aria-pressed={view === option.value}
                    onClick={() => setView(option.value)}>
              {view === option.value && (
                <motion.span layoutId="ice-nav-view-pill" className="ice-segmented__pill"
                             transition={{ type: "spring", stiffness: 500, damping: 36 }} />
              )}
              <span className="ice-segmented__label">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, padding: "0 var(--ice-space-2)" }}>
        {conversations.isLoading && <SkeletonRows rows={6} height={16} />}
        {conversations.error && (
          <BannerLike title="会话列表加载失败"
                      detail={(conversations.error as RpcError).message}
                      onRetry={() => conversations.refetch()} />
        )}
        {!conversations.isLoading && !conversations.error && filtered.length === 0 && (
          filter.trim()
            ? <EmptyState title="没有匹配的会话" hint={`没有标题包含「${filter.trim()}」的会话。`} />
            : <EmptyState title={showDeleted ? "回收站是空的" : showArchived ? "没有归档会话" : "还没有会话"}
                          hint={showArchived || showDeleted ? undefined : "点击上方「新建会话」开始讨论或初稿。"} />
        )}
        <ul className="ice-nav-list">
          <AnimatePresence initial={false} mode="popLayout">
            {filtered.map(row => (
              <motion.li key={row.id} layout="position"
                         initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                         exit={{ opacity: 0, x: -16, transition: { duration: 0.15 } }}
                         transition={{ type: "spring", stiffness: 420, damping: 36 }}>
                <ConversationRow row={row} showArchived={showArchived} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
      <SectionTitle>草稿箱（保存 ≠ 采纳）</SectionTitle>
      <div style={{ flexShrink: 0, maxHeight: 200, overflowY: "auto", padding: "0 var(--ice-space-2) var(--ice-space-2)" }}>
        {drafts.isLoading && <SkeletonRows rows={2} height={12} gap={8} />}
        {!drafts.isLoading && (drafts.data ?? []).length === 0 && (
          <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", padding: "0 4px" }}>
            暂无保存的草稿。初稿候选在对话中「保存为草稿」后出现在这里。
          </div>
        )}
        <ul className="ice-nav-list">
          {(drafts.data ?? []).map(draft => (
            <DraftRowView key={draft.draft_id} draft={draft} />
          ))}
        </ul>
      </div>
      <NavFooter version={version} />
    </div>
  );
}

const READINESS: Record<string, { dot: string; label: string }> = {
  ready: { dot: "ok", label: "模型已就绪" },
  untested: { dot: "warn", label: "模型待测试" },
  missing: { dot: "bad", label: "未配置模型" },
  unknown: { dot: "", label: "模型设置" },
};

function NavFooter({ version }: { version?: string }) {
  const readiness = READINESS[useModelReadiness()];
  return (
    <div style={{ flexShrink: 0, borderTop: "1px solid var(--ice-border)", padding: "6px var(--ice-space-2)",
                  display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
      <Button variant="ghost" size="sm" onClick={() => settingsStore.set(true)} title="模型与 Key 设置（Ctrl+,）">
        <span className={"ice-dot" + (readiness.dot ? " ice-dot--" + readiness.dot : "")} aria-hidden />
        {readiness.label}
      </Button>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" size="sm" title="切换到经典界面：素材、版本、备份等完整功能"
              onClick={() => switchToClassic().catch(error =>
                toast.error({ title: "无法切换界面", detail: (error as Error).message }))}>
        经典界面
      </Button>
      {version && <span style={{ fontSize: 11, color: "var(--ice-text-disabled)", paddingRight: 4,
                                 whiteSpace: "nowrap", marginLeft: "auto" }}>v{version}</span>}
    </div>
  );
}

type RowFeedback = { title: string; undo?: () => Promise<unknown> };

function ConversationRow({ row, showArchived }: { row: ConversationRow; showArchived: boolean }) {
  const current = useSyncExternalStore(conversationStore.subscribe, conversationStore.get);
  const selected = current === row.id;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const act = async (method: string, params: Record<string, unknown>, feedback: RowFeedback) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const wasSelected = selected;
    try {
      await flushAllDirty(); // 删除/归档前落盘编辑器
      await rpc(method, params);
      if (wasSelected) conversationStore.set(null);
      await refreshConversationLists();
      const undo = feedback.undo;
      toast.success({
        title: feedback.title,
        action: undo ? {
          label: "撤销",
          run: async () => {
            await undo();
            await refreshConversationLists();
            if (wasSelected) { editorStore.set(null); conversationStore.set(row.id); }
          },
        } : undefined,
      });
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const id = { conversation_id: row.id };
  return (
    <>
      <div className={"ice-nav-row" + (selected ? " ice-nav-row--selected" : "") + (busy ? " ice-nav-row--busy" : "")}>
        <button
          type="button"
          className="ice-nav-row__main"
          disabled={busy}
          onClick={async () => {
            setError(null);
            try { await flushAllDirty(); editorStore.set(null); conversationStore.set(row.id); }
            catch (error) { setError((error as Error).message); }
          }}
          aria-current={selected ? "true" : undefined}
          title={row.title}
        >
          <span className="ice-nav-row__title">{row.title}</span>
          <span className="ice-nav-row__meta">{shortTime(row.updated_at)}</span>
        </button>
        <div className="ice-nav-row__actions">
          {busy ? <Spinner size={12} /> : !row.deleted && !showArchived ? (
            <>
              <RowAction label="归档" title={`归档「${row.title}」，可在「归档」中恢复`}
                         onClick={() => act("chat.update", { ...id, archived: true }, {
                           title: "已归档会话", undo: () => rpc("chat.update", { ...id, archived: false }) })} />
              <RowAction label="删除" title={`把「${row.title}」移入回收站，可还原`}
                         onClick={() => act("chat.delete", id, {
                           title: "已移入回收站", undo: () => rpc("chat.restore", id) })} />
            </>
          ) : (
            <RowAction label={row.deleted ? "还原" : "恢复"} title={`恢复「${row.title}」到最近会话`}
                       onClick={() => act(row.deleted ? "chat.restore" : "chat.update", { ...id, archived: false },
                         { title: "已恢复到最近会话" })} />
          )}
        </div>
      </div>
      {error && <div role="alert" className="ice-error-text" style={{ padding: "2px var(--ice-space-2)" }}>{error}</div>}
    </>
  );
}

function RowAction({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return <Button variant="ghost" size="sm" onClick={onClick} title={title} aria-label={title}>{label}</Button>;
}

function DraftRowView({ draft }: { draft: DraftRow }) {
  const [open, setOpen] = React.useState(false);
  const detail = useAccountQuery<DraftRow>("drafts.get", { draft_id: draft.draft_id },
    { enabled: open, staleTime: 0 });
  const statusLabel = draft.status === "accepted" ? "已采纳" :
    draft.status === "unapproved" ? "待审" : "手动";
  return (
    <li className="ice-nav-row">
      <button type="button" className="ice-nav-row__main" onClick={() => setOpen(true)}
              style={{ padding: "4px var(--ice-space-2)", fontSize: "var(--ice-font-size-sm)" }}
              title={draft.title}>
        <span className="ice-nav-row__title">{draft.title}</span>
        <span className="ice-nav-row__meta">{statusLabel}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={draft.title}
              footer={<Button onClick={() => setOpen(false)}>关闭</Button>}>
        <p style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", marginTop: 0 }}>
          状态：{statusLabel} · 草稿保存在草稿库，不等于采纳或发布。
          {draft.series ? ` · ${draft.series}${draft.episode ? `-${String(draft.episode).padStart(3, "0")}` : ""}` : ""}
        </p>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--ice-font-ui)",
                      background: "var(--ice-surface-muted)", padding: 12, borderRadius: 8,
                      maxHeight: "50vh", overflowY: "auto", fontSize: "var(--ice-font-size-sm)" }}>
          {detail.isLoading ? "正在读取草稿…" : detail.error
            ? "读取失败：" + (detail.error as RpcError).message
            : detail.data?.body ?? draft.body ?? ""}
        </pre>
      </Dialog>
    </li>
  );
}

function AccountSwitcher({ accounts, activeAccountId }: {
  accounts: BootstrapAccount[]; activeAccountId: string;
}) {
  const [switching, setSwitching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div style={{ padding: "var(--ice-space-3)", display: "grid", gap: "var(--ice-space-2)" }}>
      <label className="ice-sr-only" htmlFor="ice-account-select">切换公众号</label>
      <select
        id="ice-account-select"
        value={activeAccountId}
        disabled={switching}
        onChange={async event => {
          const nextId = event.target.value;
          if (nextId === activeAccountId) return;
          setSwitching(true);
          setError(null);
          try {
            // R04：切换前把全部脏对象（编辑器草稿）立即落盘到当前账号域。
            await flushAllDirty();
            await rpc("accounts.switch", { account_id: nextId });
            // 整体清缓存 + 更新账号域（防串公众号）。
            resetForAccountSwitch(nextId);
            window.location.reload();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setSwitching(false);
          }
        }}
        style={{
          height: "var(--ice-control-height)", borderRadius: "var(--ice-radius-md)",
          border: "1px solid var(--ice-border)", background: "var(--ice-surface)", width: "100%",
        }}
      >
        {accounts.map(account => (
          <option key={account.id} value={account.id}>{account.name}</option>
        ))}
      </select>
      {error && <div role="alert" style={{ color: "var(--ice-danger)", fontSize: 12 }}>{error}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      margin: "var(--ice-space-2) var(--ice-space-3)", fontSize: "var(--ice-font-size-sm)",
      color: "var(--ice-text-secondary)", fontWeight: 600, textTransform: "none",
    }}>{children}</h2>
  );
}

function BannerLike({ title, detail, onRetry }: { title: string; detail: string; onRetry?: () => void }) {
  return (
    <div role="alert" style={{
      margin: "var(--ice-space-2)", padding: "var(--ice-space-2) var(--ice-space-3)",
      background: "var(--ice-danger-bg)", borderRadius: "var(--ice-radius-md)", fontSize: "var(--ice-font-size-sm)",
    }}>
      <strong>{title}</strong>
      <div style={{ color: "var(--ice-text-secondary)" }}>{detail}</div>
      {onRetry && <button type="button" className="ice-link-btn" style={{ marginTop: 4 }} onClick={onRetry}>重试</button>}
    </div>
  );
}
