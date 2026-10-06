// 左栏导航（M2-04）：账号切换、最近会话、草稿入口、对象路由 ID。
// 同一会话多轮只出现一条最近记录（conversation_id 稳定，见数据合同）。
import * as React from "react";

import { EmptyState, Input, Spinner } from "../../components/ui";
import { resetForAccountSwitch, rpc, useAccountQuery, type RpcError } from "../../data/client";

type BootstrapAccount = { id: string; name: string };
type ConversationRow = {
  id: string; title: string; updated_at: string;
  archived: number | boolean; deleted: number | boolean;
};

export function LeftNav({ accounts, activeAccountId }: {
  accounts: BootstrapAccount[]; activeAccountId: string;
}) {
  const [filter, setFilter] = React.useState("");
  const conversations = useAccountQuery<ConversationRow[]>("chat.list", {},
    { staleTime: 3_000, refetchInterval: 15_000 });

  const filtered = React.useMemo(() => {
    const rows = conversations.data ?? [];
    const needle = filter.trim().toLowerCase();
    const visible = rows.filter(row => !row.deleted && !row.archived);
    if (!needle) return visible.slice(0, 50);
    return visible.filter(row => row.title.toLowerCase().includes(needle)).slice(0, 50);
  }, [conversations.data, filter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <AccountSwitcher accounts={accounts} activeAccountId={activeAccountId} />
      <div style={{ padding: "0 var(--ice-space-3) var(--ice-space-2)" }}>
        <Input placeholder="搜索会话（当前公众号）" value={filter}
               onChange={event => setFilter(event.target.value)}
               aria-label="搜索会话" style={{ width: "100%" }} />
      </div>
      <SectionTitle>最近会话</SectionTitle>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 var(--ice-space-2)" }}>
        {conversations.isLoading && (
          <div style={{ display: "grid", placeItems: "center", padding: "var(--ice-space-5)" }}><Spinner /></div>
        )}
        {conversations.error && (
          <BannerLike title="会话列表加载失败"
                      detail={(conversations.error as RpcError).message} />
        )}
        {!conversations.isLoading && filtered.length === 0 && (
          <EmptyState title="还没有会话" hint="在中栏开始一次讨论或初稿。" />
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
          {filtered.map(row => (
            <li key={row.id}>
              <ConversationLink conversationId={row.id} title={row.title} />
            </li>
          ))}
        </ul>
      </div>
      <SectionTitle>草稿箱</SectionTitle>
      <div style={{ padding: "0 var(--ice-space-3) var(--ice-space-3)", color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>
        草稿面板随 M2-07 接入（对象级 dirty 恢复）。
      </div>
    </div>
  );
}

function ConversationLink({ conversationId, title }: { conversationId: string; title: string }) {
  const [current, setCurrent] = React.useState<string | null>(null);
  React.useEffect(() => {
    try { setCurrent(window.localStorage.getItem("ice.ui.conversation")); } catch { /* 忽略 */ }
  }, []);
  const selected = current === conversationId;
  return (
    <button
      onClick={() => { try { window.localStorage.setItem("ice.ui.conversation", conversationId); } catch { /* 忽略 */ } setCurrent(conversationId); }}
      aria-current={selected ? "true" : undefined}
      style={{
        width: "100%", textAlign: "left", padding: "6px var(--ice-space-2)",
        border: "none", borderRadius: "var(--ice-radius-md)", cursor: "pointer",
        background: selected ? "var(--ice-info-bg)" : "transparent",
        color: "var(--ice-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}
      title={title}
    >{title}</button>
  );
}

function AccountSwitcher({ accounts, activeAccountId }: {
  accounts: BootstrapAccount[]; activeAccountId: string;
}) {
  const [switching, setSwitching] = React.useState(false);
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
          try {
            await rpc("accounts.switch", { account_id: nextId });
            // 整体清缓存 + 更新账号域（防串公众号）。
            resetForAccountSwitch(nextId);
          } finally {
            setSwitching(false);
            window.location.reload();
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

function BannerLike({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="alert" style={{
      margin: "var(--ice-space-2)", padding: "var(--ice-space-2) var(--ice-space-3)",
      background: "var(--ice-danger-bg)", borderRadius: "var(--ice-radius-md)", fontSize: "var(--ice-font-size-sm)",
    }}>
      <strong>{title}</strong>
      <div style={{ color: "var(--ice-text-secondary)" }}>{detail}</div>
    </div>
  );
}
