// 最终交付审阅（批次 B）：只读快照与 ready 导出同一套校验；用户确认时带上快照摘要，
// 期间正文、标题或配图有任何变化，后端拒绝旧确认。
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Banner, Button, Dialog, SkeletonRows } from "../../components/ui";
import { toast } from "../../components/toast";
import { accountStore, queryClient, rpc, useAccountQuery, useCurrentAccount, type RpcError } from "../../data/client";
import { switchToClassic } from "../../data/desktop";
import { ImageThumbnail, ImageViewer, type ImageTarget } from '../assets/ImageViewer';

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
  image: { label: "去配图", hint: "打开当前文章配图工作台，导入、审核并采纳图片" },
  claims: { label: "去核验", hint: "在经典界面的事实核验页逐条核验" },
  evidence: { label: "去运行", hint: "在经典界面的演示程序页运行当前代码，留下运行证据" },
  body: { label: "回正文编辑", hint: "关闭审阅并回到正文编辑器，修改后保存新版本" },
  rules: null, plan: null,
};

// 批E1：rules/plan 没有直达新入口——明确说明现有处理路径，不显示无效“去修复”。
const NO_FIX_PATH: Partial<Record<Blocker["kind"], string>> = {
  rules: "规则问题来自正文内容：回正文编辑修改后保存新版本，再刷新本审阅。",
  plan: "配图计划需要调整：在配图工作台完成计划审阅后回到这里。",
};

const STATUS_TEXT: Record<string, string> = { accepted: "已采纳", pending: "待审核", rejected: "已否决" };

export function DeliveryReviewDialog({ jobId, open, onOpenChange, dirty, onExportReady, onFixImages, onFixBody }: {
  jobId: string; open: boolean; onOpenChange: (open: boolean) => void;
  dirty: boolean; onExportReady: () => void;
  onFixImages?: (figureNo?: number) => void;
  onFixBody?: () => void;
}) {
  const snapshot = useDeliverySnapshot(jobId);
  const account=useCurrentAccount(),active=React.useRef(true);
  React.useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const [confirming, setConfirming] = React.useState(false);
  const confirmingRef = React.useRef(false); // E3：同步防重——同 tick 双击只发一次 delivery_confirm
  const [acknowledgedHash,setAcknowledgedHash] = React.useState<string|null>(null);
  const [openIssuesOnly, setOpenIssuesOnly] = React.useState(false); // E1：只看未完成
  const data = snapshot.data;
  React.useEffect(() => { if (open) void snapshot.refetch(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const imageBlocked = data?.blocking.some(item => item.kind === "image" || item.kind === "body") ?? true;
  const confirmBlockedBy = snapshot.error ? "快照读取失败，请刷新后继续" : snapshot.isFetching ? "正在刷新审阅快照" : !data ? "正在读取审阅快照" : dirty ? "编辑器里有未保存的修改，请先保存新版本"
    : data.running ? "任务正在运行，请等待停止" : imageBlocked ? "正文或必需配图未就绪，确认后仍会因变化而失效"
    : data.review.reviewed ? "当前内容已确认" : acknowledgedHash===data.delivery_hash ? "确认已保存，请刷新最新状态" : null;

  const refreshConfirmed = async () => {
    if(!active.current||accountStore.get()!==account)return;
    try { await snapshot.refetch({throwOnError:true}); }
    catch(error) {
      if(!active.current||accountStore.get()!==account)return;
      toast.warning({title:"确认已完成，状态读取失败",detail:(error as Error).message,
        action:{label:"重新读取",run:refreshConfirmed}});
    }
  };

  const confirm = async () => {
    if (!data || confirmBlockedBy || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      await rpc("articles.delivery_confirm", { job_id: jobId, account_id:account, delivery_hash: data.delivery_hash });
      if(!active.current||accountStore.get()!==account)return;
      setAcknowledgedHash(data.delivery_hash);
      toast.success({ title: "已确认交付审阅", detail: "再修改正文、标题或配图会使本次确认失效" });
      // E3：确认已成功；随后的快照重读失败必须与“确认失败”区分开，只提供只读重试。
      await refreshConfirmed();
    } catch (error) {
      if(!active.current||accountStore.get()!==account)return;
      toast.error({ title: "确认未完成", detail: (error as RpcError).message,
                    action: { label: "刷新快照", run: () => snapshot.refetch({throwOnError:true}) } });
    } finally {
      confirmingRef.current=false;
      if(active.current)setConfirming(false);
    }
  };

  const remaining = data?.blocking ?? [];
  const exportable = Boolean(!snapshot.error && !snapshot.isFetching && !dirty && !data?.running && data?.review.reviewed && !data.review.stale && remaining.length === 0);
  return (
    <Dialog open={open} onOpenChange={next=>{if(!confirming)onOpenChange(next);}} width={760} title="最终交付审阅"
            description="核对将要交付的标题、正文、配图、运行证据与检查结果。确认后才能导出发布就绪包；之后任何修改都会让确认失效。"
            footer={<>
              <span style={{ flex: 1, fontSize: "var(--ice-font-size-sm)", color: "var(--ice-text-secondary)" }}>
                {confirmBlockedBy && !data?.review.reviewed ? confirmBlockedBy : ""}
              </span>
              <Button disabled={confirming} onClick={()=>onOpenChange(false)}>关闭审阅</Button>
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
          {/* 批E1：检查分类摘要 + “只看未完成”（未完成项与强制阻断不会被隐藏；ready 判断仍来自服务端）。 */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} role="status" aria-label="交付检查分类">
            <CategorySummary data={data} />
            <label style={{ marginLeft: "auto", fontSize: "var(--ice-font-size-sm)", display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={openIssuesOnly} onChange={event => setOpenIssuesOnly(event.target.checked)} />
              只看未完成
            </label>
          </div>
          <Section title={remaining.length ? `还有 ${remaining.length} 项阻断` : "没有阻断项"} tone={remaining.length ? "danger" : "success"}>
            <AnimatePresence initial={false}>
              {remaining.map((item, index) => (
                <motion.div key={item.kind + item.message} layout initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ delay: index * 0.03 }}
                            className="ice-review-item ice-review-item--danger">
                  <span style={{ flex: 1, minWidth: 0 }}>{item.message}</span>
                  {FIX[item.kind] && (
                    <Button size="sm" title={FIX[item.kind]!.hint} onClick={() => {
                      if (item.kind === 'image' && onFixImages) { onFixImages(item.figure_no); return; }
                      if (item.kind === 'body' && onFixBody) { onFixBody(); return; }
                      void switchToClassic().catch(error => toast.error({ title: "无法切换界面", detail: (error as Error).message }));
                    }}>
                      {FIX[item.kind]!.label}
                    </Button>
                  )}
                  {!FIX[item.kind] && NO_FIX_PATH[item.kind] && (
                    <span style={{ color: "var(--ice-text-secondary)", fontSize: "var(--ice-font-size-sm)", flexShrink: 0 }}>
                      {NO_FIX_PATH[item.kind]}
                    </span>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            {remaining.length === 0 && <div className="ice-review-empty">规则、事实、配图与运行证据均已就绪。</div>}
          </Section>
          {(!openIssuesOnly || data.figures.some(figure => !figure.valid)) && (
            <FiguresSection jobId={jobId} figures={openIssuesOnly ? data.figures.filter(figure => !figure.valid) : data.figures}
                            hiddenValidCount={openIssuesOnly ? data.figures.filter(figure => figure.valid).length : 0}
                            onFixImages={onFixImages} />
          )}
          {data.programs.length > 0 && (!openIssuesOnly || data.programs.some(program => !program.evidence)) && (
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

function FiguresSection({ jobId, figures, hiddenValidCount, onFixImages }: {
  jobId: string; figures: DeliverySnapshot["figures"]; hiddenValidCount: number;
  onFixImages?: (figureNo?: number) => void;
}) {
  const account = useCurrentAccount();
  const [enlarged, setEnlarged] = React.useState<ImageTarget | null>(null);
  if (figures.length === 0) return null;
  return (
    <Section title={`配图（${figures.filter(f => f.valid).length}/${figures.length} 已采纳）${hiddenValidCount > 0 ? ` · 已隐藏 ${hiddenValidCount} 个已就绪图位` : ""}`}>
      <div className="ice-review-figures">
        {figures.map(figure => (
          <figure key={figure.slot_id} className={"ice-review-figure" + (figure.valid ? "" : " ice-review-figure--missing")}>
            {figure.candidate
              ? <ImageThumbnail target={{ kind: 'candidate', accountId: account, jobId, candidateId: figure.candidate.candidate_id, caption: figure.caption }} onOpen={setEnlarged} />
              : <div className="ice-review-thumb ice-review-thumb--empty">待配图</div>}
            <figcaption>
              <strong>图{figure.figure_no}</strong> {figure.caption}
              <div style={{ color: "var(--ice-text-secondary)" }}>
                {figure.candidate ? `${figure.candidate.source} · ${STATUS_TEXT[figure.candidate.review_status] ?? figure.candidate.review_status}`
                  : figure.required ? "必需图位" : "可选图位"}
              </div>
              {onFixImages && <Button size="sm" onClick={() => onFixImages(figure.figure_no)}>准备图{figure.figure_no}</Button>}
            </figcaption>
          </figure>
        ))}
      </div>
      {enlarged && <ImageViewer target={enlarged} onClose={() => setEnlarged(null)} />}
    </Section>
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

/** 批E1：六类检查的 ✓/✗ 摘要（未知=快照缺数据；全部来自服务端字段）。 */
function CategorySummary({ data }: { data: DeliverySnapshot }) {
  const required = data.figures.filter(figure => figure.required);
  const items: Array<{ label: string; state: "ok" | "todo" | "unknown"; note: string }> = [
    { label: "正文", state: data.body_chars > 0 ? "ok" : "todo", note: `${data.body_chars} 字符` },
    { label: "必需图片", state: required.length === 0 ? "unknown" : required.every(figure => figure.valid) ? "ok" : "todo",
      note: required.length === 0 ? "本文没有必需图位" : `${required.filter(figure => figure.valid).length}/${required.length}` },
    { label: "程序证据", state: data.programs.length === 0 ? "unknown" : data.programs.every(program => program.evidence) ? "ok" : "todo",
      note: data.programs.length === 0 ? "无演示程序" : `${data.programs.filter(program => program.evidence).length}/${data.programs.length}` },
    { label: "事实核验", state: data.claims.length === 0 ? "ok" : "todo",
      note: data.claims.length === 0 ? "无待核验断言" : `${data.claims.length} 条未核验` },
    { label: "规则检查", state: data.rules.passed ? "ok" : "todo",
      note: !data.rules.passed && data.rules.blocking.length===0 ? "未通过，请查看阻塞项" : data.rules.blocking.length === 0
        ? data.rules.warnings.length ? `${data.rules.warnings.length} 项提醒` : "通过"
        : `${data.rules.blocking.length} 项阻断` },
    { label: "交付审阅", state: data.review.reviewed && !data.review.stale ? "ok" : "todo",
      note: data.review.reviewed ? (data.review.stale ? "已过期" : "已确认") : "待确认" },
  ];
  return <>
    {items.map(item => (
      <span key={item.label} className="ice-badge" title={`${item.label}：${item.note}`}
            style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        {item.state === "ok" ? "✓" : item.state === "todo" ? "✗" : "？"}{item.label}
      </span>
    ))}
  </>;
}
