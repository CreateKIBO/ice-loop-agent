// ICE Loop Studio v2.0 新工作台入口（M2-01/02/03/05 壳）。
// 数据面：TanStack Query over window.ice.request；账号切换整体清缓存。
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import { ErrorBoundary, WorkbenchShell } from "./app/WorkbenchShell";
import { Banner, ErrorPanel, Spinner } from "./components/ui";
import { accountStore, queryClient, rpc } from "./data/client";
import { ChatPane } from "./features/chat/ChatPane";
import { LeftNav } from "./features/navigation/LeftNav";

type Bootstrap = {
  version: string;
  account: { id: string; name: string };
  accounts: Array<{ id: string; name: string }>;
};

function App() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: Bootstrap }
  >({ phase: "loading" });

  const load = () => {
    setState({ phase: "loading" });
    rpc<Bootstrap>("bootstrap")
      .then(data => {
        accountStore.set(data.account.id);
        setState({ phase: "ready", data });
      })
      .catch((error: Error) => setState({ phase: "error", message: error.message }));
  };
  useEffect(load, []);

  if (state.phase === "loading") {
    return <div style={{ display: "grid", placeItems: "center", height: "100%", gap: 12 }}>
      <Spinner size={22} />
      <span style={{ color: "var(--ice-text-secondary)" }}>正在连接本地引擎…</span>
    </div>;
  }
  if (state.phase === "error") {
    return <div style={{ padding: "var(--ice-space-6)" }}>
      <ErrorPanel title="无法连接本地引擎" detail={state.message} onRetry={load} />
    </div>;
  }

  const { data } = state;
  return (
    <WorkbenchShell
      left={<LeftNav accounts={data.accounts} activeAccountId={data.account.id} />}
      center={
        <div style={{ padding: "var(--ice-space-4)", display: "grid", gap: "var(--ice-space-3)", alignContent: "start" }}>
          <h1 style={{ margin: 0, fontSize: "var(--ice-font-size-lg)" }}>ICE Loop Studio 工作台</h1>
          <Banner tone="info" title="v2.0 工作台（阶段预览）">
            壳、设计系统、账号隔离数据层与事件通道已就绪。对话、编辑器、审阅与资源功能按 M3–M7 阶段接入。
          </Banner>
        </div>
      }
      right={<div style={{ padding: "var(--ice-space-3)" }}>文章 / 任务（M2-07）</div>}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);
