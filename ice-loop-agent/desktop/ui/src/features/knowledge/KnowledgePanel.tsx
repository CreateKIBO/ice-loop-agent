// 知识检索面板（M4-05）：统一搜索、命中片段高亮、出处、手选引文。
// 检索离线可用（后端 FTS5/LIKE 自动分派）；结果为空是真实结果不是错误。
import * as React from "react";
import { motion } from "motion/react";

import { Button, Input, SkeletonRows } from "../../components/ui";
import { ErrorNote } from "../../components/ErrorNote";
import { toast } from "../../components/toast";
import { citationStore, rpc, useCitations, type RpcError } from "../../data/client";

type SearchHit = {
  chunk_id: string; section: string; text: string; source_id: string;
  chunk_hash?: string;
  display_name: string; origin: string; article_id: string | null;
  revision_id: string | null; marked: string; mode: string;
};

const MAX_MARKS = 400; // marked 片段可能很长，展示截断

function MarkedText({ marked }: { marked: string }) {
  const text = marked.length > MAX_MARKS ? marked.slice(0, MAX_MARKS) + "…" : marked;
  const parts = text.split(/(『[^』]*』)/g);
  return (
    <div style={{ fontSize: "var(--ice-font-size-sm)", lineHeight: 1.6 }}>
      {parts.map((part, index) => part.startsWith("『")
        ? <mark key={index} style={{ background: "rgba(36,72,219,0.18)" }}>{part.slice(1, -1)}</mark>
        : <span key={index}>{part}</span>)}
    </div>
  );
}

const MAX_CITATIONS = 8; // 与 citationStore / 后端 ContextPack 上限一致

export function KnowledgePanel() {
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<
    { phase: "idle" } | { phase: "loading" } | { phase: "error"; error: unknown } |
    { phase: "done"; hits: SearchHit[]; mode: string; query: string }
  >({ phase: "idle" });
  const [importing, setImporting] = React.useState(false);
  const citations = useCitations();
  const cited = React.useMemo(() => new Set(citations.map(item => item.chunkId)), [citations]);
  // 连续检索时只采用最后一次请求的结果，慢返回的旧结果不覆盖新结果。
  const searchSeq = React.useRef(0);

  const run = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) { setState({ phase: "idle" }); return; }
    const seq = ++searchSeq.current;
    setState({ phase: "loading" });
    try {
      const result = await rpc<{ results: SearchHit[]; mode: string }>("knowledge.search",
                                                                       { query: trimmed, limit: 20 });
      if (seq === searchSeq.current) setState({ phase: "done", hits: result.results, mode: result.mode, query: trimmed });
    } catch (error) {
      if (seq === searchSeq.current) setState({ phase: "error", error });
    }
  };

  const importFile = async () => {
    if (!window.ice?.pickKnowledgeFile || importing) return;
    const picked = await window.ice.pickKnowledgeFile();
    if (!picked) return;
    setImporting(true);
    try {
      await rpc("knowledge.import", { file_path: picked });
      const name = picked.split(/[\\/]/).pop() ?? picked;
      toast.success({ title: `已导入「${name}」`, detail: "现在就可以检索到它的内容" });
      // 导入不清空现有结果；有搜索词时重跑一次，让新文档的命中出现。
      if (query.trim()) await run(query);
    } catch (error) {
      toast.error({ title: "导入失败", detail: (error as RpcError).message });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1,
                  borderBottom: "1px solid var(--ice-border)" }}>
      <div style={{ padding: "var(--ice-space-2) var(--ice-space-3)", display: "flex", gap: 6,
                    alignItems: "center" }}>
        <strong style={{ fontSize: "var(--ice-font-size-md)" }}>知识检索</strong>
        <span style={{ flex: 1 }} />
        <Button onClick={importFile} loading={importing}
                title="导入 MD/TXT/DOCX（原文只读，同内容自动去重）">导入文档</Button>
      </div>
      <div style={{ padding: "0 var(--ice-space-3) var(--ice-space-2)", display: "grid", gap: 4 }}>
        <Input value={query} placeholder="搜索旧文/资料（Enter 检索，Esc 清空）" aria-label="知识检索"
               type="search" style={{ width: "100%" }}
               onChange={event => setQuery(event.target.value)}
               onKeyDown={event => {
                 if (event.key === "Enter") { event.preventDefault(); void run(query); }
                 if (event.key === "Escape" && query) {
                   event.preventDefault(); setQuery(""); searchSeq.current += 1; setState({ phase: "idle" });
                 }
               }} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 80, padding: "0 var(--ice-space-2)", display: "grid",
                    gap: "var(--ice-space-2)", alignContent: "start" }}>
        {state.phase === "loading" && <SkeletonRows rows={3} height={44} gap={8} />}
        {state.phase === "error" && (
          <div style={{ padding: 4 }}>
            <ErrorNote error={state.error} note="检索词保留，可重试或换词。"
                       onRetry={() => void run(query)} retryLabel="重试检索" />
          </div>
        )}
        {state.phase === "idle" && (
          <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", padding: 4 }}>
            在已发布旧文和导入资料中查找；点「引用」把片段放进下一条消息的上下文。
          </div>
        )}
        {state.phase === "done" && state.hits.length === 0 && (
          <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", padding: 4 }}>
            「{state.query}」没有命中。可以换个搜索词，或先导入文档。
          </div>
        )}
        {state.phase === "done" && state.hits.length > 0 && (
          <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", padding: "0 4px" }}>
            {state.hits.length} 条命中 · 已引用 {citations.length}/{MAX_CITATIONS}
          </div>
        )}
        {state.phase === "done" && state.hits.map((hit, index) => {
          const isCited = cited.has(hit.chunk_id);
          const full = !isCited && citations.length >= MAX_CITATIONS;
          return (
            <motion.div key={hit.chunk_id}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(index, 8) * 0.03, duration: 0.18 }}
                        className={"ice-card ice-card--compact" + (isCited ? " ice-card--selected" : "")}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: "var(--ice-font-size-sm)", minWidth: 0 }}>
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={hit.display_name}>{hit.display_name}</strong>
                <span style={{ color: "var(--ice-text-secondary)", flexShrink: 0 }}>{hit.section || "正文"}</span>
                <span style={{ flex: 1 }} />
                <motion.button type="button" className="ice-link-btn" style={{ flexShrink: 0 }}
                        whileTap={full ? undefined : { scale: 0.88 }}
                        disabled={full}
                        title={full ? `最多引用 ${MAX_CITATIONS} 条，先在输入框上方移除一些` : undefined}
                        aria-pressed={isCited}
                        onClick={() => isCited ? citationStore.remove(hit.chunk_id) : citationStore.add({
                          chunkId: hit.chunk_id, displayName: hit.display_name,
                          section: hit.section || "正文", hash: hit.chunk_hash ?? "" })}>
                  {isCited ? "已引用 ✓" : full ? "已满" : "引用"}
                </motion.button>
              </div>
              <MarkedText marked={hit.marked} />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
