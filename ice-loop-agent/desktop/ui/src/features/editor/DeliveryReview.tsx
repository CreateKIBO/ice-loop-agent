// 最终交付审阅（批次 B）：只读快照与 ready 导出同一套校验；用户确认时带上快照摘要，
// 期间正文、标题或配图有任何变化，后端拒绝旧确认。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, Dialog, SkeletonRows } from "../../components/ui";
import { toast } from "../../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery, type RpcError } from "../../data/client";
import { switchToClassic } from "../../data/desktop";

type Blocker = { kind: "image" | "plan" | "rules" | "claims" | "evidence" | "body"; message: string;
                 figure_no?: number; filename?: string };
type Finding = { rule: string; message: string; excerpt: string };

export type DeliverySnapshot = {
  job_id: string; job_state: string; running: boolean; title: string;
  body_hash: string; body_chars: number; revision_id: string; delivery_hash: string;
  review: { reviewed: boolean; stale: boolean; reviewed_at: string | null };
  figures: Array<{ figure_no: number; slot_id: string; caption: string; required: boolean; valid: boolean;
                   candidate: { candidate_id: string; source: string; review_status: string; sha256: string } | null }>;
  programs: Array<{ filename: string; evidence: boolean }>;
  rules: { passed: boolean; blocking: Finding[]; warnings: Finding[] };
  claims: Array<{ claim_id: string; text: string; risk_type: string | null; status: string | null }>;
  blocking: Blocker[];
};

export const useDeliverySnapshot = (jobId: string) =>
  useAccountQuery<DeliverySnapshot>("articles.delivery_snapshot", { job_id: jobId }, { staleTime: 10_000 });

export const refreshDeliverySnapshot = () =>
  queryClient.invalidateQueries({ queryKey: ["ice", accountStore.get(), "articles.delivery_snapshot"] });

export function reviewBadge(snapshot: DeliverySnapshot | undefined) {
  if (!snapshot) return { label: "交付审阅", tone: "" };
  if (snapshot.review.reviewed) return { label: "已审阅", tone: "success" };
  if (snapshot.review.stale) return { label: "审阅已过期", tone: "warning" };
  return { label: "待审阅", tone: "" };
}

const FIX: Record<Blocker["kind"], { label: string; hint: string } | null> = {
  image: { label: "去配图", hint: "在经典界面的配图页导入、审核并采纳图片" },
  claims: { label: "去核验", hint: "在经典界面的事实核验页逐条核验" },
  evidence: { label: "去运行", hint: "在经典界面的演示程序页运行当前代码，留下运行证据" },
  rules: null, plan: null, body: null,
};

const STATUS_TEXT: Record<string, string> = { accepted: "已采纳", pending: "待审核", rejected: "已否决" };

export function DeliveryReviewDialog({ jobId, open, onOpenChange, dirty, onExportReady }: {
  jobId: string; open: boolean; onOpenChange: (open: boolean) => void;
  dirty: boolean; onExportReady: () => void;
}) {
  const snapshot = useDeliverySnapshot(jobId);
  const [confirming, setConfirming] = React.useState(false);
  const data = snapshot.data;
  React.useEffect(() => { if (open) void snapshot.refetch(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const imageBlocked = data?.blocking.some(item => item.kind === "image" || item.kind === "body") ?? true;
  const confirmBlockedBy = !data ? "正在读取审阅快照" : dirty ? "编辑器里有未保存的修改，请先保存新版本"
    : data.running ? "任务正在运行，请等待停止" : imageBlocked ? "正文或必需配图未就绪，确认后仍会因变化而失效"
    : data.review.reviewed ? "当前内容已确认" : null;

  const confirm = async () => {
    if (!data || confirmBlockedBy) return;
    setConfirming(true);
    try {
      await rpc("articles.delivery_confirm", { job_id: jobId, delivery_hash: data.delivery_hash });
      toast.success({ title: "已确认交付审阅", detail: "再修改正文、标题或配图会使本次确认失效" });
      await refreshDeliverySnapshot();
    } catch (error) {
      toast.error({ title: "确认未完成", detail: (error as RpcError).message,
                    action: { label: "刷新快照", run: () => snapshot.refetch() } });
    } finally {
      setConfirming(false);
    }
  };

  const remaining = data?.blocking ?? [];
  const exportable = Boolean(data?.review.reviewed && remaining.length === 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={760} title="最终交付审阅"
            description="核对将要交付的标题、正文、配图、运行证据与检查结果。确认后才能导出发布就绪包；之后任何修改都会让确认失效。"
            footer={<>
              <span style={{ flex: 1, fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
                {confirmBlockedBy && !data?.review.reviewed ? confirmBlockedBy : ""}
              </span>
              <Button variant="ghost" onClick={() => snapshot.refetch()} loading={snapshot.isFetching && !snapshot.isLoading}>刷新</Button>
              {exportable
                ? <Button variant="primary" onClick={() => { onOpenChange(false); onExportReady(); }}>导出发布就绪包</Button>
                : <Button variant="primary" loading={confirming} disabled={Boolean(confirmBlockedBy)}
                          title={confirmBlockedBy ?? "确认当前正文、标题与配图可以交付"} onClick={confirm}>
                    确认交付审阅
                  </Button>}
            </>}>
      {snapshot.isLoading && <SkeletonRows rows={6} height={18} />}
      {snapshot.error && <Banner tone="danger" title="读取审阅快照失败">{snapshot.error.message}</Banner>}
      {data && (
        <div style={{ display: "grid", gap: "var(--ice-space-4)" }}>
          <ReviewHeader data={data} dirty={dirty} />
          <Section title={remaining.length ? `还有 ${remaining.length} 项阻断` : "没有阻断项"} tone={remaining.length ? "danger" : "success"}>
            <AnimatePresence initial={false}>
              {remaining.map((item, index) => (
                <motion.div key={item.kind + item.message} layout initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ delay: index * 0.03 }}
                            className="ice-review-item ice-review-item--danger">
                  <span style={{ flex: 1, minWidth: 0 }}>{item.message}</span>
                  {FIX[item.kind] && (
                    <Button size="sm" title={FIX[item.kind]!.hint} onClick={() => switchToClassic().catch(error =>
                      toast.error({ title: "无法切换界面", detail: (error as Error).message }))}>
                      {FIX[item.kind]!.label}
                    </Button>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            {remaining.length === 0 && <div className="ice-review-empty">规则、事实、配图与运行证据均已就绪。</div>}
          </Section>
          <FiguresSection jobId={jobId} figures={data.figures} />
          {data.programs.length > 0 && (
            <Section title={`演示程序（${data.programs.filter(p => p.evidence).length}/${data.programs.length} 有当前运行证据）`}>
              {data.programs.map(program => (
                <div key={program.filename} className={"ice-review-item" + (program.evidence ? "" : " ice-review-item--danger")}>
                  <code style={{ flex: 1 }}>{program.filename}</code>
                  <span className={"ice-badge" + (program.evidence ? " ice-badge--success" : " ice-badge--danger")}>
                    {program.evidence ? "证据有效" : "缺少证据"}
                  </span>
                </div>
              ))}
            </Section>
          )}
          {(data.rules.blocking.length > 0 || data.rules.warnings.length > 0) && (
            <Section title={`规则检查（${data.rules.blocking.length} 项阻断，${data.rules.warnings.length} 项提醒）`}>
              {[...data.rules.blocking.map(f => ({ ...f, block: true })), ...data.rules.warnings.map(f => ({ ...f, block: false }))]
                .map((finding, index) => (
                  <div key={finding.rule + index} className={"ice-review-item" + (finding.block ? " ice-review-item--danger" : "")}
                       style={{ display: "grid", gap: 2 }}>
                    <span>{finding.message}</span>
                    {finding.excerpt && <span className="ice-review-excerpt">“{finding.excerpt}”</span>}
                  </div>
                ))}
            </Section>
          )}
          {data.claims.length > 0 && (
            <Section title={`未核验事实断言（${data.claims.length}）`}>
              {data.claims.map(claim => (
                <div key={claim.claim_id} className="ice-review-item ice-review-item--danger">
                  <span style={{ flex: 1, minWidth: 0 }}>{claim.text}</span>
                  {claim.risk_type && <span className="ice-badge">{claim.risk_type}</span>}
                </div>
              ))}
            </Section>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ReviewHeader({ data, dirty }: { data: DeliverySnapshot; dirty: boolean }) {
  const badge = reviewBadge(data);
  return (
    <div style={{ display: "grid", gap: "var(--ice-space-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: "var(--ice-font-size-lg)", flex: 1, minWidth: 0 }}>{data.title}</strong>
        <motion.span key={badge.label} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                     className={"ice-badge" + (badge.tone ? " ice-badge--" + badge.tone : "")}>{badge.label}</motion.span>
      </div>
      <div style={{ fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
        正文 {data.body_chars} 字符 · 内容摘要 {data.body_hash.slice(0, 10)}
        {data.revision_id && <> · 版本 {data.revision_id.slice(0, 8)}</>}
        {data.review.reviewed_at && data.review.reviewed && <> · 确认于 {new Date(data.review.reviewed_at).toLocaleString("zh-CN")}</>}
      </div>
      {dirty && <Banner tone="warning" title="审阅针对已保存的正文">编辑器里还有未保存的修改，保存新版本后再确认。</Banner>}
      {data.review.stale && !dirty && (
        <Banner tone="warning" title="上次确认已失效">确认之后正文、标题或配图发生了变化，请重新核对后再确认。</Banner>
      )}
    </div>
  );
}

function FiguresSection({ jobId, figures }: { jobId: string; figures: DeliverySnapshot["figures"] }) {
  const [enlarged, setEnlarged] = React.useState<string | null>(null);
  if (figures.length === 0) return null;
  return (
    <Section title={`配图（${figures.filter(f => f.valid).length}/${figures.length} 已采纳）`}>
      <div className="ice-review-figures">
        {figures.map(figure => (
          <figure key={figure.slot_id} className={"ice-review-figure" + (figure.valid ? "" : " ice-review-figure--missing")}>
            {figure.candidate
              ? <Thumbnail jobId={jobId} candidateId={figure.candidate.candidate_id} alt={figure.caption}
                           onOpen={url => setEnlarged(url)} />
              : <div className="ice-review-thumb ice-review-thumb--empty">待配图</div>}
            <figcaption>
              <strong>图{figure.figure_no}</strong> {figure.caption}
              <div style={{ color: "var(--ice-text-secondary)" }}>
                {figure.candidate ? `${figure.candidate.source} · ${STATUS_TEXT[figure.candidate.review_status] ?? figure.candidate.review_status}`
                  : figure.required ? "必需图位" : "可选图位"}
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
      <AnimatePresence>
        {enlarged && (
          <motion.button type="button" className="ice-review-lightbox" onClick={() => setEnlarged(null)}
                         initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                         aria-label="关闭大图">
            <motion.img src={enlarged} alt="" initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} />
          </motion.button>
        )}
      </AnimatePresence>
    </Section>
  );
}

function Thumbnail({ jobId, candidateId, alt, onOpen }: {
  jobId: string; candidateId: string; alt: string; onOpen: (url: string) => void;
}) {
  const preview = useAccountQuery<string>("assets.preview", { job_id: jobId, candidate_id: candidateId },
                                          { staleTime: Infinity });
  if (preview.error) return <div className="ice-review-thumb ice-review-thumb--empty" title={preview.error.message}>无法预览</div>;
  if (!preview.data) return <div className="ice-review-thumb ice-skeleton" />;
  return (
    <button type="button" className="ice-review-thumb" onClick={() => onOpen(preview.data!)} title="点击放大">
      <img src={preview.data} alt={alt} />
    </button>
  );
}

function Section({ title, tone, children }: { title: string; tone?: "danger" | "success"; children: React.ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 6 }}>
      <h3 className={"ice-review-heading" + (tone ? " ice-review-heading--" + tone : "")}>{title}</h3>
      {children}
    </section>
  );
}
