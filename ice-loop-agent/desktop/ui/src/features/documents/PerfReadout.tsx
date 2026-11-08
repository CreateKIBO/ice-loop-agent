// v3.12 性能读数：只在“性能样本”文章侧栏显示，帮助在 Windows 参照机上登记首次可编辑、输入响应、保存与内存。
import * as React from "react";

import { Button } from "../../components/ui";
import { toast } from "../../components/toast";
import { docPerf } from "./docPerf";

export function PerfReadout({ meta }: { meta: Record<string, unknown> }) {
  const [, bump] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => docPerf.subscribe(bump), []);
  React.useEffect(() => { const timer = window.setInterval(bump, 2000); return () => window.clearInterval(timer); }, []);
  const snap = docPerf.snapshot();
  const sample = (meta.perf_sample ?? {}) as { chars?: number; images?: number; seed?: number; image_bytes?: number };
  const rows: Array<[string, string]> = [
    ["样本", `${sample.chars ?? "?"} 字 / ${sample.images ?? "?"} 图（种子 ${sample.seed ?? "?"}，图片共 ${sample.image_bytes ? (sample.image_bytes / 1024 / 1024).toFixed(1) + " MB" : "?"}）`],
    ["打开 → 内容到达", snap.openMs === null ? "—" : `${snap.openMs} ms`],
    ["打开 → 可以输入", snap.editableMs === null ? "—" : `${snap.editableMs} ms`],
    ["输入响应（按键→绘制）", snap.input.count ? `中位 ${snap.input.p50} ms · P95 ${snap.input.p95} ms · 最大 ${snap.input.max} ms（${snap.input.count} 次）` : "在正文里连续输入后显示"],
    ["自动保存往返", snap.saves.count ? `中位 ${snap.saves.p50} ms · 最大 ${snap.saves.max} ms（${snap.saves.count} 次）` : "输入停止约 1 秒后保存"],
    ["JS 堆（渲染进程）", snap.heapMb === null ? "当前环境不提供" : `${snap.heapMb} MB · 峰值 ${snap.heapPeakMb} MB`],
  ];
  const copy = async () => {
    const text = ["| 指标 | 结果 |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      "", "说明：输入响应为按键到下一帧绘制的近似值；JS 堆不含图片解码与 GPU 内存，整进程峰值请用任务管理器记录。"].join("\n");
    try {
      const bridge = window.ice?.copyText as undefined | ((value: string) => Promise<unknown>);
      if (typeof bridge === "function") await bridge(text); else await navigator.clipboard.writeText(text);
      toast.success({ title: "已复制性能读数" });
    } catch (error) { toast.error({ title: "没有复制", detail: (error as Error).message }); }
  };
  return (
    <div className="ice-doc-form">
      <p className="ice-doc-muted">固定样本的编辑器读数（只在本机内存中记录）。先关掉其他文章，从列表重新打开本文开始计时；在正文里连续输入一段，再滚动到底部看图片加载。</p>
      <dl className="ice-imgtool__facts">{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
      <div className="ice-doc-row"><span className="ice-doc-muted">整进程峰值内存请用任务管理器（Windows）或活动监视器记录。</span><span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => void copy()}>复制读数</Button></div>
    </div>
  );
}
