// ICE Loop Studio v2.0 新工作台入口（M2 壳 + M3 编辑器接入）。
// 数据面：TanStack Query over window.ice.request；账号切换整体清缓存。
import { StrictMode, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig, motion } from "motion/react";

import { CommandPalette, useGlobalShortcuts } from "./app/CommandPalette";
import { ModelSettings, type BootstrapSettings } from "./app/ModelSettings";
import { engineStore, paletteStore } from "./app/uiState";
import { ErrorBoundary, WorkbenchShell } from "./app/WorkbenchShell";
import { toast, Toaster } from "./components/toast";
import { Button, ErrorPanel, Spinner } from "./components/ui";
import { useAnyDirtyGuard, useCurrentConversation, useCurrentAccount, accountStore, queryClient, rpc, useEditorJob } from "./data/client";
import { onEngineExit, relaunchApp, switchToClassic } from "./data/desktop";
import { ChatPane } from "./features/chat/ChatPane";
import { Welcome } from "./features/chat/Welcome";
import { LeftNav } from "./features/navigation/LeftNav";
import { RightPane } from "./features/tasks/RightPane";
import { BrowserHost } from './app/BrowserHost';
import { PublicationSettingsHost } from './app/PublicationSettingsHost';
import { BackupSettingsHost,BackupRestoreNotice } from './app/BackupSettingsHost';
import { EditorialHost } from './app/EditorialHost';

// 编辑器带着 Tiptap / CodeMirror / remark，是启动包里最重的部分；
// 大多数时候用户停留在对话里，所以点"编辑正文"时才下载。
const ArticleEditor = lazy(() =>
  import("./features/editor/ArticleEditor").then(module => ({ default: module.ArticleEditor })));

type Bootstrap = BootstrapSettings & {
  version: string;
  account: { id: string; name: string };
  accounts: Array<{ id: string; name: string }>;
};

function Center() {
  const editorJob = useEditorJob();
  const conversationId = useCurrentConversation();
  useAnyDirtyGuard();
  const view = editorJob ? "editor:" + editorJob : conversationId ? "chat:" + conversationId : "welcome";
  return (
    // 按视图重挂载并淡入：切会话/进编辑器时有明确的"换了一页"的感觉，旧内容不会残留闪烁。
    <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {editorJob ? (
        <Suspense fallback={
          <div style={{ flex: 1, display: "grid", placeItems: "center", gap: 8, alignContent: "center" }}>
            <Spinner size={20} />
            <span style={{ color: "var(--ice-text-secondary)" }}>正在载入编辑器…</span>
          </div>}>
          <ArticleEditor key={editorJob} jobId={editorJob} />
        </Suspense>
      ) : conversationId ? <ChatPane conversationId={conversationId} /> : <Welcome />}
    </motion.div>
  );
}

function EngineBanner() {
  const status = engineStore.use();
  const [restarting, setRestarting] = useState(false);
  useEffect(() => onEngineExit(() => engineStore.set("exited")), []);
  if (status !== "exited") return null;
  return (
    <motion.div className="ice-engine-banner" role="alert"
                initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}>
      <strong>本地文章引擎已退出</strong>
      <span style={{ flex: 1, opacity: 0.9 }}>已保存的内容不受影响；重启应用后即可继续。</span>
      <Button loading={restarting} onClick={() => { setRestarting(true); void relaunchApp(); }}>重启应用</Button>
    </motion.div>
  );
}

function Splash({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  style={{ display: "grid", justifyItems: "center", gap: 14 }}>
        <span className="ice-welcome__mark" aria-hidden>i</span>
        {children}
      </motion.div>
    </div>
  );
}

function Workspace({ data }: { data: Bootstrap }) {
  const account = useCurrentAccount();
  const conversation = useCurrentConversation();
  const editor = useEditorJob();
  return <WorkbenchShell navigationKey={`${account}:${conversation || ""}:${editor || ""}`}
    left={<LeftNav accounts={data.accounts} activeAccountId={data.account.id} version={data.version} />}
    center={<Center />} right={<RightPane />} />;
}

function App() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; data: Bootstrap }
  >({ phase: "loading" });
  const palette = paletteStore.use();
  useGlobalShortcuts();

  const load = () => {
    setState({ phase: "loading" });
    rpc<Bootstrap>("bootstrap")
      .then(data => {
        accountStore.set(data.account.id);
        // 与 useBootstrap 同 key：模型就绪状态、欢迎页直接用这份数据，不重复请求。
        queryClient.setQueryData(["ice", data.account.id, "bootstrap", {}], data);
        if (data.credential_warning) toast.warning({ title: "模型凭据需要处理", detail: data.credential_warning });
        setState({ phase: "ready", data });
      })
      .catch((error: Error) => setState({ phase: "error", message: error.message }));
  };
  useEffect(load, []);

  if (state.phase === "loading") {
    return <Splash>
      <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ice-text-secondary)" }}>
        <Spinner size={14} /> 正在连接本地引擎…
      </span>
    </Splash>;
  }
  if (state.phase === "error") {
    return <div style={{ padding: "var(--ice-space-6)", maxWidth: 640, margin: "0 auto", display: "grid", gap: 12 }}>
      <ErrorPanel title="无法连接本地引擎" detail={state.message} onRetry={load} />
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={() => void relaunchApp()}>重启应用</Button>
        <Button variant="ghost" onClick={() => void switchToClassic()}>切换到经典界面</Button>
      </div>
    </div>;
  }

  const { data } = state;
  return (
    <MotionConfig reducedMotion="user">
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <EngineBanner />
        <BackupRestoreNotice />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Workspace data={data} />
        </div>
      </div>
      <CommandPalette open={palette} onOpenChange={paletteStore.set} />
      <ModelSettings />
      <PublicationSettingsHost />
      <BackupSettingsHost />
      <EditorialHost />
      <BrowserHost />
      <Toaster />
    </MotionConfig>
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
