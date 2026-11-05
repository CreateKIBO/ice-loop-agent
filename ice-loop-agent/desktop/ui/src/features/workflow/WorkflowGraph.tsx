// 工作流图（M6-05）：React Flow 只作状态投影——节点=工作流步骤、边=顺序依赖。
// 数据来自 workflow.graph（steps 表真实状态）；禁止任意脚本节点。
import * as React from "react";
import {
  Background,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { rpc, type RpcError } from "../../data/client";

type GraphNode = {
  id: string; order: number; state: string;
  attempt: number; error: string;
};

const STATE_COLOR: Record<string, string> = {
  succeeded: "var(--ice-success)", running: "var(--ice-signal-blue)", failed: "var(--ice-danger)",
  paused: "var(--ice-warning)", queued: "var(--ice-text-disabled)",
};

const NODE_LABEL: Record<string, string> = {
  ingest: "导入", topic: "选题", research: "取证", outline: "骨架",
  draft: "初稿", verify_code: "真实执行", integrate_evidence: "证据回填",
  article_review: "文章审校", style_review: "风格终审",
  title_workshop: "标题工坊", asset_plan: "配图计划", assets: "配图",
  final_check: "终检", export: "导出",
};

function WorkflowGraphInner({ jobId }: { jobId: string }) {
  const [graph, setGraph] = React.useState<{
    nodes: GraphNode[]; edges: Array<{ source: string; target: string }>;
    job_state: string; current_node: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await rpc<{ nodes: GraphNode[]; edges: Array<{ source: string; target: string }>;
                                job_state: string; current_node: string }>(
          "workflow.graph", { job_id: jobId });
        if (!cancelled) { setGraph(data); setError(null); }
      } catch (err) {
        if (!cancelled) setError((err as RpcError).message);
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [jobId]);

  if (error) return <div style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)" }}>工作流图加载失败：{error}</div>;
  if (!graph) return null;

  const nodes: Node[] = graph.nodes.map((node, index) => ({
    id: node.id,
    position: { x: (index % 4) * 190, y: Math.floor(index / 4) * 96 },
    data: {
      label: (
        <div style={{ fontSize: 12 }}>
          <strong>{NODE_LABEL[node.id] ?? node.id}</strong>
          <div style={{ color: STATE_COLOR[node.state] ?? "var(--ice-text-secondary)" }}>
            {node.state}{node.attempt > 1 ? ` · 第${node.attempt}次` : ""}
          </div>
          {node.error && <div style={{ color: "var(--ice-danger)", maxWidth: 160 }}>{node.error}</div>}
        </div>
      ),
    },
    style: {
      background: "var(--ice-surface)", border: `2px solid ${STATE_COLOR[node.state] ?? "var(--ice-border-strong)"}`,
      borderRadius: 8, width: 170,
    },
  }));
  const edges: Edge[] = graph.edges.map((edge, index) => ({
    id: `e${index}`, source: edge.source, target: edge.target,
    animated: graph.current_node === edge.source,
  }));

  return (
    <div style={{ width: "100%", height: 320, border: "1px solid var(--ice-border)",
                  borderRadius: "var(--ice-radius-md)", overflow: "hidden" }}
         aria-label="工作流状态图" role="img">
      <ReactFlow nodes={nodes} edges={edges} fitView
                 proOptions={{ hideAttribution: true }}
                 nodesDraggable={false} nodesConnectable={false}
                 edgesFocusable={false} elementsSelectable={false}>
        <Background color="#EDEBE4" gap={16} />
      </ReactFlow>
    </div>
  );
}

export function WorkflowGraph({ jobId }: { jobId: string | null }) {
  if (!jobId) return null;
  return <WorkflowGraphInner key={jobId} jobId={jobId} />;
}
