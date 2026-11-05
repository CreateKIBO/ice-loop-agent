// 左栏导航（M2-04 + R04/R12 批次二）：账号切换（先落盘脏对象）、新建会话、
// 最近会话（归档/删除/恢复）、草稿箱（真实 chat.drafts 列表 + 正文查看）。
import * as React from "react";
import { useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button, Dialog, EmptyState, FilteredEmpty, Input, SkeletonRows, Spinner } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { applyAccountBootstrap,createConversation,openGettingStarted } from "../../data/actions";
import { refreshAfterWrite } from "../../data/receipts";
import {
  accountStore, conversationStore, editorStore, flushAllDirty, queryClient,
  rpc, useAccountQuery, useCurrentAccount,
} from "../../data/client";
import { switchToClassic } from "../../data/desktop";
import { useBootstrap,useModelReadiness } from "../../app/modelBootstrap";
import { editorialStore,backupSettingsStore,publicationSettingsStore,settingsStore,shortcutHelpStore } from "../../app/uiState";
import { CopyButton } from "../../components/CopyButton";
import { openWebsite } from '../../data/websites';
import { MarkdownContent } from "../../components/MarkdownContent";
import { focusAfterRowRemoval } from "../../components/focusRestore";
import { usePaneActive } from "../../app/PaneActivity";

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
const refreshConversationLists = (account = accountStore.get()) =>
  queryClient.invalidateQueries({ queryKey: ["ice", account, "chat.list"] }, { throwOnError: true });

export function LeftNav({ accounts, activeAccountId, version }: {
  accounts: BootstrapAccount[]; activeAccountId: string; version?: string;
}) {
  const active = usePaneActive();
  const [filter, setFilter] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<ListView>("active");
  const showArchived = view === "archived", showDeleted = view === "deleted";
  const requestId = React.useRef<string | null>(null);
  const conversations = useAccountQuery<ConversationRow[]>("chat.list", { archived: showArchived, deleted: showDeleted },
    { enabled: active, staleTime: 3_000, refetchInterval: 15_000 });
  const drafts = useAccountQuery<DraftRow[]>("chat.drafts", {},
    { enabled: active, staleTime: 5_000, refetchInterval: 20_000 });

  const filtered = React.useMemo(() => {
    const rows = conversations.data ?? [];
    const needle = filter.trim().toLowerCase();
    const visible = rows.filter(row => showDeleted ? row.deleted : showArchived
      ? (!row.deleted && !!row.archived)
      : (!row.deleted && !row.archived));
    if (!needle) return visible;
    return visible.filter(row => row.title.toLowerCase().includes(needle));
  }, [conversations.data, filter, showArchived, showDeleted]);
  const filteredDrafts = (drafts.data ?? []).filter(draft => !filter.trim()
    || (draft.title + " " + (draft.series ?? "")).toLowerCase().includes(filter.trim().toLowerCase()));

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
      <div className="ice-nav-new" style={{ padding: "0 var(--ice-space-3) var(--ice-space-2)" }}>
        <Button variant="primary" loading={creating} disabled={creating} onClick={newConversation}>新建会话</Button>
        {createError && <ErrorNote error={createError} note="没有创建任何会话，可安全重试（同一请求键不会建出两个会话）。"
                                  onRetry={newConversation} retryLabel="重试新建" />}
      </div>
      <div style={{ padding: "0 var(--ice-space-3) var(--ice-space-2)", display: "grid", gap: "var(--ice-space-2)" }}>
        <Input placeholder="搜索会话或草稿" value={filter} type="search"
               onChange={event => setFilter(event.target.value)}
               onKeyDown={event => { if (event.key === "Escape" && filter) { event.preventDefault(); setFilter(""); } }}
               aria-label="搜索会话或草稿" style={{ width: "100%" }} />
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
      <div className="ice-nav-summary"><span>{showDeleted ? "已删除会话" : showArchived ? "归档会话" : "最近会话"} · {filtered.length}</span>
        {filter && <button type="button" className="ice-link-btn" onClick={() => setFilter("")}>清除搜索</button>}
      </div>
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, padding: "0 var(--ice-space-2)" }}>
        {conversations.isLoading && <SkeletonRows rows={6} height={16} />}
        {conversations.error && (
          <div style={{ padding: "var(--ice-space-2)" }}>
            <ErrorNote error={conversations.error} note="会话本身未受影响。"
                       onRetry={() => conversations.refetch()} retryLabel="重新加载列表" />
          </div>
        )}
        {!conversations.isLoading && !conversations.error && filtered.length === 0 && (
          filter.trim()
            ? <FilteredEmpty filterLabel={`标题包含「${filter.trim()}」`} onClear={() => setFilter("")} />
            : <EmptyState title={showDeleted ? "回收站是空的" : showArchived ? "没有归档会话" : "还没有会话"}
                          hint={showArchived || showDeleted ? undefined : "点击上方「新建会话」开始讨论或初稿。"} />
        )}
        <ul className="ice-nav-list" tabIndex={-1} aria-label="会话列表，行被移除后焦点落到相邻会话">
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
      <SectionTitle>草稿箱 <span className="ice-nav-count">{filteredDrafts.length}</span></SectionTitle>
      <div style={{ flexShrink: 0, maxHeight: 200, overflowY: "auto", padding: "0 var(--ice-space-2) var(--ice-space-2)" }}>
        {drafts.isLoading && <SkeletonRows rows={2} height={12} gap={8} />}
        {drafts.error && <ErrorNote error={drafts.error} onRetry={() => drafts.refetch()} retryLabel="重新加载草稿" />}
        {!drafts.isLoading && !drafts.error && filteredDrafts.length === 0 && (
          <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", padding: "0 4px" }}>
            {filter.trim() ? "没有匹配的草稿。" : "在对话中保存初稿后会出现在这里，保存不等于采纳。"}
          </div>
        )}
        <ul className="ice-nav-list">
          {filteredDrafts.map(draft => (
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
  unrouted: { dot: "warn", label: "需设置写作模型" },
  unknown: { dot: "", label: "模型设置" },
};

function NavFooter({ version }: { version?: string }) {
  const readiness = READINESS[useModelReadiness()];
  return (
    // 第25轮：底部改为"模型状态条 + 两列工具"，按钮文案与顺序不变。
    <div className="ice-nav-footer">
      <Button variant="ghost" size="sm" className="ice-nav-footer__status" data-readiness={readiness.dot || "unknown"}
              onClick={() => settingsStore.set(true)} title="模型与 Key 设置（Ctrl+,）">
        <span className={"ice-dot" + (readiness.dot ? " ice-dot--" + readiness.dot : "")} aria-hidden />
        {readiness.label}
      </Button>
      <div className="ice-nav-footer__tools">
      <Button variant="ghost" size="sm" onClick={()=>void openGettingStarted().catch(error=>toast.error({title:'暂时无法返回指南',detail:(error as Error).message}))}>开始指南</Button>
      <Button variant="ghost" size="sm" onClick={() => openWebsite('tapnow')}>网页工作台</Button>
      <Button variant="ghost" size="sm" onClick={()=>editorialStore.set(true)}>选题与排期</Button>
      <Button variant="ghost" size="sm" onClick={()=>backupSettingsStore.set(true)}>备份与恢复</Button>
      <Button variant="ghost" size="sm" onClick={()=>shortcutHelpStore.set(true)}>使用帮助</Button>
      <Button variant="ghost" size="sm" title="切换到经典界面：更多管理工具"
              onClick={() => switchToClassic().catch(error =>
                toast.error({ title: "无法切换界面", detail: (error as Error).message }))}>
        经典界面
      </Button>
      </div>
      {version && <span className="ice-nav-footer__version">v{version}</span>}
    </div>
  );
}

type RowFeedback = { title: string; undo?: (account: string) => Promise<unknown> };

function ConversationRow({ row, showArchived }: { row: ConversationRow; showArchived: boolean }) {
  const account = useCurrentAccount();
  const current = useSyncExternalStore(conversationStore.subscribe, conversationStore.get);
  const selected = current === row.id;
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false); // 2026-10-20：同 tick 连点绕过 state 闭包（与重命名同缺陷），ref 双闸
  const [error, setError] = React.useState<unknown>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const act = async (method: string, params: Record<string, unknown>, feedback: RowFeedback) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const wasSelected = selected;
    try {
      await flushAllDirty(); // 删除/归档前落盘编辑器
      if (accountStore.get() !== account) throw Error("公众号已切换，请在原公众号操作");
      await rpc(method, { ...params, account_id: account });
      if (accountStore.get() === account && conversationStore.get() === row.id) conversationStore.set(null);
      focusAfterRowRemoval(rowRef.current, ".ice-nav-row__main");
      const undo = feedback.undo;
      toast.success({
        title: feedback.title,
        action: undo ? {
          label: "撤销",
          run: async () => {
            if (accountStore.get() !== account) throw Error("请先切回原公众号再撤销");
            await flushAllDirty();
            if (accountStore.get() !== account) throw Error("公众号已切换，已取消撤销");
            await undo(account);
            await refreshAfterWrite("撤销", () => refreshConversationLists(account));
            if (wasSelected && accountStore.get() === account) { editorStore.set(null); conversationStore.set(row.id); }
          },
        } : undefined,
      });
      // 写已成功；列表刷新失败只提示刷新，不冒充归档/删除失败（批次A-04）。
      await refreshAfterWrite(feedback.title, () => refreshConversationLists(account));
    } catch (error) { setError(error); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const id = { conversation_id: row.id };
  return (
    <>
      <div ref={rowRef} className={"ice-nav-row" + (selected ? " ice-nav-row--selected" : "") + (busy ? " ice-nav-row--busy" : "")}>
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
                           title: "已归档会话", undo: account => rpc("chat.update", { ...id, account_id: account, archived: false }) })} />
              <RowAction label="删除" title={`把「${row.title}」移入回收站，可还原`}
                         onClick={() => act("chat.delete", id, {
                           title: "已移入回收站", undo: account => rpc("chat.restore", { ...id, account_id: account }) })} />
            </>
          ) : (
            <RowAction label={row.deleted ? "还原" : "恢复"} title={`恢复「${row.title}」到最近会话`}
                       onClick={() => act(row.deleted ? "chat.restore" : "chat.update", { ...id, archived: false },
                         { title: "已恢复到最近会话" })} />
          )}
        </div>
      </div>
      {error != null && <div style={{ padding: "2px var(--ice-space-2)" }}>
        <ErrorNote error={error} note="操作未生效，当前列表保持原状。" /></div>}
    </>
  );
}

function RowAction({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return <Button variant="ghost" size="sm" onClick={onClick} title={title} aria-label={title}>{label}</Button>;
}

function DraftRowView({ draft }: { draft: DraftRow }) {
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState(false);
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
      <Dialog open={open} onOpenChange={setOpen} title={draft.title} width={820}
              description="已保存草稿 · 保存不等于采纳或发布"
              footer={<Button onClick={() => setOpen(false)}>关闭</Button>}>
        <p style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", marginTop: 0 }}>
          状态：{statusLabel} · 草稿保存在草稿库，不等于采纳或发布。
          {draft.series ? ` · ${draft.series}${draft.episode ? `-${String(draft.episode).padStart(3, "0")}` : ""}` : ""}
        </p>
        {detail.isLoading ? <SkeletonRows rows={5} /> : detail.error ? <ErrorNote error={detail.error}
          onRetry={() => detail.refetch()} retryLabel="重新读取草稿" /> : <>
          <div className="ice-draft-view-controls"><div className="ice-segmented" role="group" aria-label="草稿阅读模式">
            <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>排版预览</button>
            <button type="button" aria-pressed={source} onClick={() => setSource(true)}>Markdown</button>
          </div><CopyButton text={detail.data?.body ?? draft.body ?? ""} label="复制草稿" /></div>
          <div className="ice-draft-reading">{source ? <pre>{detail.data?.body ?? draft.body ?? ""}</pre>
            : <MarkdownContent text={detail.data?.body ?? draft.body ?? ""} />}</div>
        </>}
      </Dialog>
    </li>
  );
}

function AccountSwitcher({ accounts:initialAccounts, activeAccountId:initialId }: {
  accounts: BootstrapAccount[]; activeAccountId: string;
}) {
  const [switching, setSwitching] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const boot=useBootstrap().data;
  const current=useSyncExternalStore(accountStore.subscribe,accountStore.get);
  const accounts=boot?.accounts??initialAccounts,activeAccountId=current||initialId;
  return (
    <div style={{ padding: "var(--ice-space-3)", display: "grid", gap: "var(--ice-space-2)" }}>
      {/* 第25轮：账号卡（首字头像 + 原生 select），select 的 id、值与切换流程不变。 */}
      <div className="ice-account-card" data-switching={switching || undefined}>
      <span className="ice-account-card__avatar" aria-hidden>
        {(accounts.find(account => account.id === activeAccountId)?.name || "?").trim().slice(0, 1).toUpperCase()}
      </span>
      <span className="ice-account-card__body">
      <span className="ice-account-card__eyebrow" aria-hidden>公众号</span>
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
            const result=await rpc<{account:{id:string}}>("accounts.switch", { account_id: nextId });
            // 整体清缓存 + 更新账号域（防串公众号）。切换已在服务端完成，
            // 本地引导失败只提示刷新视图，不回滚成"账号未切换"（批次A-04）。
            try {
              if(accountStore.get()===activeAccountId)applyAccountBootstrap(result);
            } catch (bootstrapError) {
              toast.warning({ title: "账号已切换，界面数据刷新失败",
                detail: (bootstrapError as Error).message,
                action: { label: "重试刷新", run: () => applyAccountBootstrap(result) } });
            }
          } catch (error) {
            setError(error);
          } finally {
            setSwitching(false);
          }
        }}
        className="ice-account-card__select"
      >
        {accounts.map(account => (
          <option key={account.id} value={account.id}>{account.name}</option>
        ))}
      </select>
      </span>
      </div>
      <Button variant="ghost" size="sm" disabled={switching} onClick={()=>publicationSettingsStore.set(true)}>公众号与品牌</Button>
      {error != null && <ErrorNote error={error} note="账号未切换，当前账号数据保持不变。" />}
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
